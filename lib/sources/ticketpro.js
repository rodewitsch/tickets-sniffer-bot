// Источник Ticketpro.by: серверный рендер (Yii). Парсим HTML карточек событий
// (выдача поиска, страница события, страница площадки) регэкспами; JSON-LD
// используем для обогащения (диапазон цен, точное время, картинка) и как fallback.
//
// Важно: у ticketpro в JSON-LD нет eventStatus, а у отменённых/перенесённых
// событий availability остаётся InStock. Поэтому статус определяем по HTML:
// бейдж event-box__category-cancel, кнопка «Отменен» без href, слова
// «ОТМЕНЕН»/«ПЕРЕНЕСЕН» в описании карточки/страницы.
import { httpGet } from '../http.js';
import { extractJsonLd } from '../jsonld.js';
import { normalizeLdEvent } from '../normalize.js';
import { formatDateRu, textMatchesQuery } from '../util.js';
import { CITY_LABELS } from '../cities.js';

const SITE = 'https://www.ticketpro.by';

// Кэш списка площадок (/koncertnye-ploshhadki/) для поиска площадки в Mini App.
let venueIndex = null;
let venueIndexAt = 0;
const VENUE_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const VENUE_INDEX_MAX_PAGES = 30;
const VENUE_INDEX_CONCURRENCY = 4;

const ENTITIES = {
  '&quot;': '"', '&#039;': "'", '&nbsp;': ' ', '&laquo;': '«',
  '&raquo;': '»', '&ndash;': '–', '&mdash;': '—', '&amp;': '&',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&(?:quot|#039|nbsp|laquo|raquo|ndash|mdash|amp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function absUrl(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return SITE + (u.startsWith('/') ? '' : '/') + u;
}

const CITY_NAMES = new Set(Object.values(CITY_LABELS).map(normText));

function isCity(s) {
  return CITY_NAMES.has(normText(s));
}

// «Минск, ГУ Дворец Республики» (поиск) или «Центральный дом офицеров, Минск»
// (страница события). cityFirst подсказывает порядок, каталог городов уточняет.
function splitPlace(place, cityFirst) {
  const s = decodeEntities(place);
  const m = s.match(/^\s*([^,]+),\s*([^,]+?)\s*$/);
  if (!m) return { city: null, venue: s || null };
  const a = m[1].trim();
  const b = m[2].trim();
  if (isCity(a) && !isCity(b)) return { city: a, venue: b };
  if (!isCity(a) && isCity(b)) return { city: b, venue: a };
  return cityFirst ? { city: a, venue: b } : { city: b, venue: a };
}

// «от 95,00 BYN» | «145,00 - 555,00 BYN» → { priceFrom, priceTo, currency }
function parsePrice(raw) {
  const s = decodeEntities(raw);
  const nums = (s.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
  const cur = /\b(BYN|BYR|USD|EUR|RUB)\b/i.exec(s)?.[1] || 'BYN';
  const norm = (n) => (n == null ? null : String(parseFloat(n).toFixed(2)).replace('.', ','));
  if (!nums.length) return { priceFrom: null, priceTo: null, currency: cur };
  return { priceFrom: norm(nums[0]), priceTo: nums[1] != null ? norm(nums[1]) : null, currency: cur };
}

// «05.12.2026, 19:00» | «05.12.2026» | «01.05.2026 - 30.10.2026»
function parseDateText(raw) {
  const s = decodeEntities(raw);
  const range = /^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (range) {
    const [, d1, m1, y1, d2, m2, y2] = range;
    const t1 = Date.UTC(+y1, +m1 - 1, +d1) / 1000;
    const t2 = Date.UTC(+y2, +m2 - 1, +d2) / 1000;
    return { startsAt: t1, dateText: `${formatDateRu(t1, false)} – ${formatDateRu(t2, false)}` };
  }
  const single = /^(\d{2})\.(\d{2})\.(\d{4})(?:,\s*(\d{2}):(\d{2}))?/.exec(s);
  if (single) {
    const [, d, mo, y, h, mi] = single;
    const hasTime = !!h;
    const ts = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0)) / 1000;
    return { startsAt: ts, dateText: formatDateRu(ts, hasTime) };
  }
  return { startsAt: null, dateText: s || null };
}

// Статус по признакам HTML: 'cancelled' | 'postponed' | null.
function statusMark(htmlSlice) {
  if (/event-box__category-cancel|ОТМЕНЕН|ОТМЕНЯЕТСЯ|ОТМЕНЕНА|ОТМЕНЕНО|>Отменен</i.test(htmlSlice)) return 'cancelled';
  if (/ПЕРЕНЕСЕН|ПЕРЕНОСИТСЯ|ПЕРЕНЕСЕНА|ПЕРЕНЕСЕНО/i.test(htmlSlice)) return 'postponed';
  return null;
}

// Нормализует событие в единую модель (как у «афиши»).
function finalize(ev) {
  const norm = (p) => (p == null ? null : String(p).replace('.', ','));
  return {
    source: 'ticketpro',
    uid: ev.uid,
    title: ev.title || null,
    venue: ev.venue || null,
    city: ev.city || null,
    dateText: ev.dateText || null,
    startsAt: ev.startsAt || null,
    url: ev.url,
    image: ev.image || null,
    priceFrom: norm(ev.priceFrom),
    priceTo: norm(ev.priceTo),
    currency: ev.currency || 'BYN',
    onSale: !!ev.onSale,
    status: ev.status || 'nosale',
  };
}

// Первый schema.org Event в JSON-LD куска HTML (карточки/страницы).
function normalizeFirstEventLd(html) {
  for (const ld of extractJsonLd(html)) {
    const type = ld['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => String(t).toLowerCase() === 'event')) continue;
    const ev = normalizeLdEvent(ld, 'ticketpro');
    if (ev) return ev;
  }
  return null;
}

// Сливает данные HTML-карточки с JSON-LD (JSON-LD добивает диапазон цен/время/картинку).
function mergeEvent(card, ld) {
  const pick = (a, b) => a || b || null;
  const hasMark = card._mark != null;
  return finalize({
    uid: card.uid,
    title: pick(card.title, ld?.title),
    venue: pick(card.venue, ld?.venue),
    city: pick(card.city, ld?.city),
    dateText: pick(card.dateText, ld?.dateText),
    startsAt: card.startsAt || ld?.startsAt || null,
    url: card.url,
    image: pick(card.image, ld?.image),
    priceFrom: pick(card.priceFrom, ld?.priceFrom),
    priceTo: pick(card.priceTo, ld?.priceTo),
    currency: pick(card.currency, ld?.currency),
    onSale: hasMark ? card.onSale : (ld ? ld.onSale : card.onSale),
    status: hasMark ? card.status : (ld ? ld.status : card.status),
  });
}

// Разбор одной карточки события (выдача поиска / страница площадки).
function parseEventCard(chunk) {
  const href = /<a\b[^>]*href="([^"]+)"[^>]*class="event-box__img"/.exec(chunk)?.[1]
    || /<a\b[^>]*class="event-box__img"[^>]*href="([^"]+)"/.exec(chunk)?.[1];
  const url = absUrl(href);
  if (!url) return null;

  const title = decodeEntities(/class="event-box__title">([\s\S]*?)<\/div>/.exec(chunk)?.[1]);
  const img = absUrl(
    /class="event-box__img"[^>]*>\s*<img[^>]*src="([^"]+)"/.exec(chunk)?.[1]
    || /class="event-box__head">[\s\S]*?<img[^>]*src="([^"]+)"/.exec(chunk)?.[1],
  );
  const placeRaw = /class="event-box__place">[\s\S]*?<\/span>\s*([\s\S]*?)<\/div>/.exec(chunk)?.[1];
  const { city, venue } = splitPlace(placeRaw, true);
  const dateRaw = /class="event-box__date">[\s\S]*?<\/span>\s*<span>([\s\S]*?)<\/span>/.exec(chunk)?.[1];
  const { startsAt, dateText } = parseDateText(dateRaw);
  const priceRaw = /class="event-box__price-box">([\s\S]*?)<\/div>/.exec(chunk)?.[1];
  const price = parsePrice(priceRaw);
  const buyHref = /class="event-box__button">[\s\S]*?href="([^"]+)"/.exec(chunk)?.[1];
  const mark = statusMark(chunk);

  const card = {
    uid: url.replace(/[?#].*$/, ''),
    title: title || null,
    url,
    image: img,
    city,
    venue,
    dateText,
    startsAt,
    priceFrom: price.priceFrom,
    priceTo: price.priceTo,
    currency: price.currency,
    onSale: !!buyHref && mark !== 'cancelled' && mark !== 'postponed',
    status: mark === 'cancelled' ? 'cancelled' : mark === 'postponed' ? 'nosale' : buyHref ? 'onsale' : 'nosale',
    _mark: mark,
  };
  return mergeEvent(card, normalizeFirstEventLd(chunk));
}

// Все карточки событий на странице (поиск и площадка: у них data-key, в отличие
// от блока «Предстоящие события», который не парсим).
//
// Важно: и найденные события, и блок «Предстоящие события» используют одинаковую
// разметку event-box, но у «Предстоящих» нет data-key. Границы чанка каждой
// карточки должны считаться по всем event-box (иначе последняя карточка выдачи
// «захватывает» начало блока «Предстоящие», и недостающие поля — напр. venue у
// фильмов — берутся из первой карточки этого блока). Поэтому все event-box
// используем как границы, а парсим только те, у открывающего тега есть data-key.
function parseEventCards(html) {
  const out = [];
  // Открывающий тег любой карточки event-box (класс может идти в любом порядке,
  // быть с доп. классами). \b исключает вложенные event-box__* элементы.
  const re = /<div\b[^>]*class="[^"]*\bevent-box\b[^"]*"[^>]*>/g;
  const bounds = [];
  let m;
  while ((m = re.exec(html))) bounds.push(m);
  for (let i = 0; i < bounds.length; i++) {
    const tag = bounds[i][0];
    // Парсим только карточки выдачи (data-key есть у поиска и площадки, но не
    // у блока «Предстоящие события»).
    if (!/data-key="\d+"/.test(tag)) continue;
    const start = bounds[i].index;
    const end = (bounds[i + 1] && bounds[i + 1].index) || html.length;
    const chunk = html.slice(start, end);
    const card = parseEventCard(chunk);
    if (card && card.title && card.url) out.push(card);
  }
  return out;
}

// Все schema.org Event со страницы (fallback, если разметка карточек изменилась).
function ldEvents(html) {
  const out = [];
  const seen = new Set();
  for (const ld of extractJsonLd(html)) {
    const type = ld['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => String(t).toLowerCase() === 'event')) continue;
    const ev = normalizeLdEvent(ld, 'ticketpro');
    if (!ev || seen.has(ev.uid)) continue;
    seen.add(ev.uid);
    out.push(finalize(ev));
  }
  return out;
}

// Разбор главного блока страницы события (заголовок/дата/площадка/цена/кнопка).
function parseEventPage(slice, pageUrl) {
  const title = decodeEntities(/<h1>([\s\S]*?)<\/h1>/.exec(slice)?.[1]);
  const img = absUrl(/class="content-poster">[\s\S]*?<img[^>]*src="([^"]+)"/.exec(slice)?.[1]);
  const dateRaw = /content__event-date">[\s\S]*?<span class="content__panel-title">\s*([\s\S]*?)\s*<\/span>/.exec(slice)?.[1];
  const placeRaw = /content__event-place">[\s\S]*?<span class="content__panel-title">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(slice)?.[1]
    || /content__event-place">[\s\S]*?<span class="content__panel-title">\s*([\s\S]*?)\s*<\/span>/.exec(slice)?.[1];
  const priceRaw = /content__event-price">[\s\S]*?<span class="content__panel-title">\s*([\s\S]*?)\s*<\/span>/.exec(slice)?.[1];
  const buyHref = /class="content__button">[\s\S]*?href="([^"]+)"/.exec(slice)?.[1];
  if (!title && !dateRaw && !placeRaw && !buyHref) return null;

  const { city, venue } = splitPlace(placeRaw, false);
  const { startsAt, dateText } = parseDateText(dateRaw);
  const price = parsePrice(priceRaw);
  const mark = statusMark(slice);
  const url = pageUrl || null;

  const card = {
    uid: url ? url.replace(/[?#].*$/, '') : null,
    title: title || null,
    url,
    image: img,
    city,
    venue,
    dateText,
    startsAt,
    priceFrom: price.priceFrom,
    priceTo: price.priceTo,
    currency: price.currency,
    onSale: !!buyHref && mark !== 'cancelled' && mark !== 'postponed',
    status: mark === 'cancelled' ? 'cancelled' : mark === 'postponed' ? 'nosale' : buyHref ? 'onsale' : 'nosale',
    _mark: mark,
  };
  return mergeEvent(card, normalizeFirstEventLd(slice));
}

// Поиск по ключевому слову. Отдаёт полные данные (цены, наличие, картинка).
export async function searchTicketpro(query) {
  const url = `${SITE}/rasshirennyj-poisk/?event_or_artist=${encodeURIComponent(query)}`;
  const { status, text } = await httpGet(url);
  if (status !== 200 || !text) return [];
  const cards = parseEventCards(text);
  const results = cards.length ? cards : ldEvents(text);
  // При нуле совпадений Ticketpro подсовывает блок «Предстоящие события» —
  // отсекаем его клиентски по пересечению токенов запроса с полями события.
  return results.filter((e) => textMatchesQuery(query, e.title, e.venue, e.city));
}

// Детали одного события по его странице.
export async function fetchTicketproEventDetails(eventUrl) {
  const { status, text } = await httpGet(eventUrl);
  if (status !== 200 || !text) return null;
  const slice = text.split('event-other js-event-other')[0];
  const card = parseEventPage(slice, eventUrl);
  if (card) return card;
  return ldEvents(slice)[0] || null;
}

// Число страниц в пагинации (rel="last" или data-page).
function parsePageCount(html) {
  const rel = /<link[^>]*rel="last"[^>]*href="[^"]*[?&]page=(\d+)"/.exec(html);
  if (rel) return Number(rel[1]);
  let max = 0;
  for (const m of html.matchAll(/data-page="(\d+)"/g)) max = Math.max(max, Number(m[1]) + 1);
  return max || 1;
}

// Ссылки на события с карточек страницы (лёгкая выжимка URL, без JSON-LD).
function parseEventLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*class="event-box__img"/g;
  for (const m of html.matchAll(re)) {
    const url = absUrl(m[1]);
    const uid = url && url.replace(/[?#].*$/, '');
    if (uid && !seen.has(uid)) { seen.add(uid); out.push(url); }
  }
  return out;
}

// События площадки (все страницы её ленты).
export async function fetchTicketproVenueEventLinks(venueUrl) {
  const base = String(venueUrl).replace(/[?#].*$/, '');
  const seen = new Set();
  const links = [];
  let pages = 1;
  for (let p = 1; p <= 5; p++) {
    const url = p === 1 ? base : `${base}?page=${p}`;
    const { status, text } = await httpGet(url);
    if (status !== 200 || !text) break;
    if (p === 1) pages = Math.min(parsePageCount(text), 5);
    const evLinks = parseEventLinks(text);
    if (!evLinks.length && p > 1) break;
    for (const l of evLinks) {
      if (!seen.has(l)) { seen.add(l); links.push({ url: l, source: 'ticketpro' }); }
    }
    if (p >= pages) break;
  }
  return links;
}

// Карточки площадок со страницы списка.
function parseVenueBoxes(html) {
  const out = [];
  const re = /<div class="venue-box">/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i], starts[i + 1] || html.length);
    const url = absUrl(/class="venue-box__img"[^>]*href="([^"]+)"/.exec(chunk)?.[1]);
    const img = absUrl(/class="venue-box__img"[^>]*>\s*<img[^>]*src="([^"]+)"/.exec(chunk)?.[1]);
    const titleRaw = /class="venue-box__title"[^>]*>([\s\S]*?)<\/a>/.exec(chunk)?.[1];
    const name = decodeEntities(titleRaw);
    if (!url || !name) continue;
    const { city } = splitPlace(name, false);
    out.push({ name, city, url, image: img });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Полный индекс площадок (кэш на 6 часов).
async function fetchVenueIndex() {
  if (venueIndex && Date.now() - venueIndexAt < VENUE_INDEX_TTL_MS) return venueIndex;
  let first;
  try { first = await httpGet(`${SITE}/koncertnye-ploshhadki/`); } catch { return venueIndex || []; }
  if (!first || first.status !== 200 || !first.text) return venueIndex || [];
  const total = Math.min(parsePageCount(first.text) || 1, VENUE_INDEX_MAX_PAGES);
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  const texts = await mapLimit(pages, VENUE_INDEX_CONCURRENCY, async (p) => {
    const url = p === 1 ? `${SITE}/koncertnye-ploshhadki/` : `${SITE}/koncertnye-ploshhadki/?page=${p}`;
    try {
      const r = await httpGet(url);
      return r && r.status === 200 ? r.text : '';
    } catch { return ''; }
  });
  const out = [];
  for (const t of texts) out.push(...parseVenueBoxes(t || ''));
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
