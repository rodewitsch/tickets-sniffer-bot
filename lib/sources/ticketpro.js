// Источник Ticketpro.by. Сайт переехал на Next.js (Tailwind), поэтому HTML-парсер
// карточек (event-box) больше не работает. Данные берём из JSON API:
//   • `/api/events/search?query=…`            — выдача поиска (полные карточки);
//   • `/api/events/search?venueId=…`          — события площадки (с пагинацией);
//   • RSC-пейлоад страницы события            — детали (статус отмены/переноса,
//     цены, время) — в HTML есть в виде сериализованного JSON.
//
// Статус события: у отменённых `status` === 'CANCELED', у перенесённых —
// `isPostponed`, у приостановленных — `isSuspended`. `isOnSale` при этом может
// оставаться true, поэтому считаем статус сами.
import { httpGet, httpJson } from '../http.js';
import { parseDate, formatDateRu, textMatchesQuery } from '../util.js';

const SITE = 'https://ticketpro.by';
const CDN = 'https://cdn.ticketpro.by';
const API = `${SITE}/api/events/search`;

// Сколько результатов просить у API за один поиск (чекер всё равно берёт первые 10).
const SEARCH_LIMIT = 50;

// Кэш списка площадок (/ru/venues отдаёт все площадки одной страницей).
let venueIndex = null;
let venueIndexAt = 0;
const VENUE_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
// Предохранитель обхода событий площадки (событий у площадки обычно ≤ 50).
const VENUE_EVENTS_MAX = 300;

const ENTITIES = {
  '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&#039;': "'", '&nbsp;': ' ',
  '&laquo;': '«', '&raquo;': '»', '&ndash;': '–', '&mdash;': '—',
  '&amp;': '&', '&lt;': '<', '&gt;': '>',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&(?:quot|x27|#39|#039|nbsp|laquo|raquo|ndash|mdash|amp|lt|gt);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

// Канонический URL события/площадки (без www, без хвостового слэша — как отдаёт
// сам сайт в канонических ссылках).
function eventUrl(slug) {
  return `${SITE}/ru/event/${slug}`;
}
function venueUrl(slug) {
  return `${SITE}/ru/venues/${slug}`;
}

// Слаг из любого формата URL (новый `/ru/event/<slug>` или старый
// `/bilety-na-koncert/<slug>/`): берём последний ненулевой сегмент пути.
function slugFromUrl(url) {
  const s = String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const segs = s.split('/').filter(Boolean);
  return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
}

// Изображение с CDN. coverS3Key — путь вида 'event/…' (может содержать пробелы
// и кириллицу), поэтому каждый сегмент кодируем отдельно.
function imgUrl(key) {
  if (!key) return null;
  let path = String(key).replace(/^https?:\/\/[^/]+/i, '');
  if (!path.startsWith('/')) path = '/' + path;
  return `${CDN}${path.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`;
}

// Цена из числа API (75 → '75,00', 307 → '307,00') — формат как у старого парсера.
function priceText(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toFixed(2).replace('.', ',');
}

// ISO-дата `startTime` ('2026-11-07T19:00:00') → unix-секунды + русский текст.
function dateFromStartTime(startTime) {
  const pd = parseDate(startTime);
  if (!pd) return { startsAt: null, dateText: null };
  return { startsAt: pd.ts, dateText: formatDateRu(pd.ts, pd.hasTime) };
}

// Карточка события из API (или из RSC-пейлоада страницы события — формат тот же).
function eventToCard(e) {
  const slug = e && e.slug;
  if (!slug || !e.title) return null;
  const url = eventUrl(slug);
  const cancelled = e.status === 'CANCELED';
  const postponed = !!e.isPostponed;
  const suspended = !!e.isSuspended;
  const onSale = !!e.isOnSale && !cancelled && !postponed && !suspended;
  const { startsAt, dateText } = dateFromStartTime(e.startTime);
  return {
    source: 'ticketpro',
    uid: url,
    title: e.title || null,
    venue: (e.venue && e.venue.title) || null,
    city: (e.venue && e.venue.city && e.venue.city.name) || null,
    dateText,
    startsAt,
    url,
    image: imgUrl(e.coverS3Key),
    priceFrom: priceText(e.minPrice),
    priceTo: priceText(e.maxPrice),
    currency: 'BYN',
    onSale,
    status: cancelled ? 'cancelled' : onSale ? 'onsale' : 'nosale',
    // Категория (кино/театр/концерт/…) — берём сразу из API; раньше её читали
    // из хлебных крошек страницы события.
    category: (e.primaryCategory && e.primaryCategory.name) || null,
  };
}

// Извлекает JSON-объект из RSC-пейлоада Next.js. Объекты сериализованы строкой
// с экранированными кавычками (`{\"id\":\"…\"}`), поэтому ищем `\"ключ\":\"значение\"`,
// затем скобочным сканером берём вмещающий объект и распаковываем его как JS-строку.
function extractRscObject(html, key, value) {
  const needle = `\\"${key}\\":\\"${value}\\"`;
  let from = 0;
  while (true) {
    const idx = html.indexOf(needle, from);
    if (idx < 0) return null;
    const start = html.lastIndexOf('{', idx);
    if (start < 0) return null;
    let depth = 0;
    let i = start;
    while (i < html.length) {
      const c = html[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      i++;
    }
    if (depth === 0) {
      const raw = html.slice(start, i + 1);
      try {
        const obj = JSON.parse(JSON.parse(`"${raw}"`));
        if (obj && obj[key] === value) return obj;
      } catch { /* не JSON — ищем следующее вхождение */ }
    }
    from = idx + 1;
  }
}

// Поиск по ключевому слову. Отдаёт полные данные (цены, наличие, картинка, категория).
export async function searchTicketpro(query) {
  const url = `${API}?query=${encodeURIComponent(query)}&offset=0&limit=${SEARCH_LIMIT}`;
  let data;
  try {
    const res = await httpJson(url);
    if (res.status !== 200) return [];
    data = res.data;
  } catch { return []; }
  if (!data || !Array.isArray(data.events)) return [];
  const cards = data.events.map(eventToCard).filter(Boolean);
  // При нуле совпадений API отдаёт нерелевантные события — отсекаем их клиентски
  // по пересечению токенов запроса с полями события.
  return cards.filter((e) => textMatchesQuery(query, e.title, e.venue, e.city));
}

// Детали одного события по его странице (RSC-пейлоад). URL может быть и старым
// (`/bilety-na-koncert/<slug>/` — сайт отдаёт 301 на новый), слаг берём из пути.
export async function fetchTicketproEventDetails(eventUrlInput) {
  const slug = slugFromUrl(eventUrlInput);
  if (!slug) return null;
  let text;
  try {
    const res = await httpGet(eventUrl(slug));
    if (res.status !== 200) return null;
    text = res.text;
  } catch { return null; }
  if (!text) return null;
  const e = extractRscObject(text, 'slug', slug);
  if (!e || !e.title) return null;
  return eventToCard(e);
}

// Категория уже есть в карточках (eventToCard), дополнительный обход не нужен.
// Функция оставлена для совместимости с server.js.
export async function enrichTicketproCategories(cards) {
  return Array.isArray(cards) ? cards : [];
}

// События площадки: id площадки читаем из RSC её страницы, затем забираем все
// события через API (пагинация) — на странице площадки отдаются не все события.
async function fetchVenueId(slug) {
  let text;
  try {
    const res = await httpGet(venueUrl(slug));
    if (res.status !== 200) return null;
    text = res.text;
  } catch { return null; }
  if (!text) return null;
  const obj = extractRscObject(text, 'slug', slug);
  return obj && obj.id ? obj.id : null;
}

export async function fetchTicketproVenueEventLinks(venueUrlInput) {
  const slug = slugFromUrl(venueUrlInput);
  if (!slug) return [];
  const venueId = await fetchVenueId(slug);
  if (!venueId) return [];
  const links = [];
  const limit = 100;
  let offset = 0;
  // Предохранитель: у площадки не бывает больше VENUE_EVENTS_MAX событий.
  while (offset < VENUE_EVENTS_MAX) {
    const url = `${API}?venueId=${encodeURIComponent(venueId)}&offset=${offset}&limit=${limit}`;
    let data;
    try {
      const res = await httpJson(url);
      if (res.status !== 200) break;
      data = res.data;
    } catch { break; }
    if (!data || !Array.isArray(data.events) || !data.events.length) break;
    for (const e of data.events) {
      if (e && e.slug) links.push({ url: eventUrl(e.slug), source: 'ticketpro' });
    }
    const total = (data.pagination && data.pagination.total) || 0;
    offset += data.events.length;
    if (offset >= total) break;
  }
  return links;
}

// Карточки площадок со страницы списка /ru/venues (одна страница — все площадки).
function parseVenueList(html) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*\bgroup\/card\b[^"]*"[^>]*href="\/ru\/venues\/([a-z0-9\-]+)"/g;
  const bounds = [];
  let m;
  while ((m = re.exec(html))) bounds.push(m);
  for (let i = 0; i < bounds.length; i++) {
    const chunk = html.slice(bounds[i].index, (bounds[i + 1] && bounds[i + 1].index) || html.length);
    const slug = bounds[i][1];
    const name = decodeEntities(/<img[^>]*alt="([^"]*)"/.exec(chunk)?.[1]);
    const image = /<img[^>]*src="([^"]+)"/.exec(chunk)?.[1];
    const addr = /<span class="text-\[14px\][^"]*">([\s\S]*?)<\/span>/.exec(chunk)?.[1];
    if (!slug || !name) continue;
    out.push({ name, city: venueCityFromAddress(addr), url: venueUrl(slug), image: imgUrl(image) });
  }
  return out;
}

// Город из адреса карточки площадки: «Минск , Минский район…» → «Минск».
function venueCityFromAddress(addrRaw) {
  if (!addrRaw) return null;
  const s = decodeEntities(addrRaw).replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();
  const city = s.split(',')[0].trim();
  return city || null;
}

// Полный индекс площадок (кэш на 6 часов).
async function fetchVenueIndex() {
  if (venueIndex && Date.now() - venueIndexAt < VENUE_INDEX_TTL_MS) return venueIndex;
  let text;
  try {
    const res = await httpGet(`${SITE}/ru/venues`);
    if (res.status !== 200) return venueIndex || [];
    text = res.text;
  } catch { return venueIndex || []; }
  const out = parseVenueList(text || '');
  if (out.length) { venueIndex = out; venueIndexAt = Date.now(); }
  return out;
}

// Поиск площадки по названию/городу (по кэшу индекса).
export async function searchTicketproVenues(query) {
  const q = normText(query);
  if (!q) return [];
  const index = await fetchVenueIndex();
  return index
    .filter((v) => normText(v.name).includes(q) || normText(v.city || '').includes(q))
    .slice(0, 20);
}
