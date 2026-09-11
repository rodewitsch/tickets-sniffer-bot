// Источник «Афиша» (24afisha.by и bycard.by — один общий бэкенд: общая база,
// одинаковые slug). Поиск ищет на обоих доменах и мёржит по slug; buy-ссылка
// ведёт на тот домен, где найдено событие.
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent, afishaSlugFromUrl, afishaCityFromUrl } from '../normalize.js';
import { MAX_CITY_PROBES, AFISHA_SHORT_TIMEOUT_MS } from '../config.js';

const API = 'https://api.24afisha.by';
const SITE = 'https://24afisha.by';
const BYCARD_API = 'https://abws.bycard.by';
const BYCARD_SITE = 'https://bycard.by';

// На каких доменах можно запрашивать список городов/страницы события.
export const AFISHA_HOSTS = ['24afisha.by', 'bycard.by'];

// Фолбэк-карта «slug → cityId» для schedule API (если /api/v2/cities недоступен).
// Выяснено из /api/v2/cities; id стабильны.
const CITY_ID_FALLBACK = {
  minsk: 3, brest: 9, vitebsk: 11, gomel: 17, grodno: 12, mogilev: 23,
  baranovichi: 27, bobruisk: 57, pinsk: 13, orsha: 14, luninec: 15,
  osipovichi: 16, stolin: 18, jitkovichi: 19, jlobin: 21, gorodok: 22,
  novopolock: 28, petrikov: 29, zhabinka: 30, kobrin: 34, polotsk: 35,
  slonim: 62, kalinkovichi: 73, mozyry: 74, rechica: 75, rogachev: 76,
  chirkovichi: 77, gantsevichi: 82, drogichin: 87, elsk: 95, ivanovo: 100,
  chechersk: 102, tolochin: 10,
};

let cityIdCache = null;

// Slug события → его числовой id (ведущие цифры slug) для schedule API.
// У некоторых событий slug без цифр в начале — тогда id не выводится.
function afishaEventIdFromSlug(urlOrSlug) {
  const slug = /\/ru\/[a-z\-]+\/(?:event|events)\/([^\/?#]+)/.exec(String(urlOrSlug))?.[1]
    || String(urlOrSlug).replace(/[?#].*$/, '');
  const m = slug.match(/^(\d+)/);
  return m ? m[1] : null;
}

// Карта «slug → cityId» для schedule API. Пытается получить с /api/v2/cities.
// Предпочитаем abws.bycard.by — общий бэкенд, но он доступен с Droplet даже когда
// заблокирован api.24afisha.by. При неудаче — фолбэк-карта.
async function afishaCityIds() {
  if (cityIdCache) return cityIdCache;
  for (const base of [BYCARD_API, API]) {
    try {
      const { ok, data } = await httpJson(`${base}/api/v2/cities`);
      if (ok && data && Array.isArray(data.data) && data.data.length) {
        const map = {};
        for (const c of data.data) {
          if (c && c.slug && c.id) map[String(c.slug)] = Number(c.id);
        }
        if (Object.keys(map).length) { cityIdCache = map; return map; }
      }
    } catch { /* пробуем следующий хост */ }
  }
  cityIdCache = CITY_ID_FALLBACK;
  return cityIdCache;
}

/**
 * Есть ли у события сеансы с открытой продажей в указанном городе (24afisha/bycard).
 * Использует schedule API (надёжно для кино и любых событий с сеансами). Для событий,
 * где числовой id вывести нельзя, — fallback на JSON-LD страницы города (offers).
 *
 * @param {string} eventUrl URL страницы события «афиши»
 * @param {string} citySlug город-слаг ('brest' и т.п.) или 'all'
 * @returns {Promise<{onSale:boolean, event?:object|null, citySlug?:string}>}
 *   event — лучшая попытка собрать событие для уведомления (pageUrl/uid/onSale/venue/date).
 */
export async function fetchAfishaCityAvailability(eventUrl, citySlug) {
  const eventId = afishaEventIdFromSlug(eventUrl);
  const cityIds = await afishaCityIds();
  const targets = citySlug === 'all'
    ? Object.values(cityIds).slice(0, MAX_CITY_PROBES)
    : [cityIds[citySlug]].filter(Boolean);

  // Пробуем schedule API: один запрос на город, стоп на первом onSale.
  for (const cityId of targets) {
    let fetched = null;
    // Предпочитаем abws.bycard.by (доступен с Droplet), затем api.24afisha.by.
    for (const base of [BYCARD_API, API]) {
      try {
        const r = await httpJson(
          `${base}/api/v2/schedule/events/${eventId}?cityId=${cityId}`,
        );
        if (r.ok && r.data) { fetched = r.data; break; }
      } catch { /* пробуем следующий хост */ }
    }
    if (!fetched) continue;
    const data = fetched;
    const item = data.data && data.data[0];
    if (!item || !Array.isArray(item.objects)) continue;
    for (const o of item.objects) {
      const session = (o.sessions || []).find((s) => s && s.isSaleOpen);
      if (session) {
        // Собираем мини-карточку события для уведомления.
        const citySlugFor = Object.keys(cityIds).find((k) => cityIds[k] === cityId) || citySlug;
        const ev = {
          source: 'afisha',
          uid: `${afishaSlugFromUrl(eventUrl)}@${citySlugFor}`,
          title: item.name || '',
          venue: o.name || null,
          city: citySlugFor,
          dateText: session.dateStr ? `${session.dateStr} ${session.timeStr || ''}`.trim() : null,
          startsAt: null,
          url: eventUrlForCity(eventUrl, citySlugFor),
          image: item.imageUrl || null,
          priceFrom: item.minPrice ? String(Number(item.minPrice) / 100).replace('.', ',') : null,
          priceTo: item.maxPrice ? String(Number(item.maxPrice) / 100).replace('.', ',') : null,
          currency: 'BYN',
          onSale: true,
          status: 'onsale',
        };
        return { onSale: true, event: ev, citySlug: citySlugFor };
      }
    }
    // Город «тихий» — сеансов с продажей нет.
    return { onSale: false, event: null, citySlug };
  }

  // Нет числового id события → fallback на JSON-LD страницы города (Event с offers).
  const pageUrl = citySlug && citySlug !== 'all' ? eventUrlForCity(eventUrl, citySlug) : eventUrl;
  const ev = await fetchAfishaEventDetails(pageUrl);
  return { onSale: !!(ev && ev.onSale), event: ev, citySlug };
}

function searchUrl(base, query) {
  return (
    `${base}/api/v2/search?target=site` +
    `&search[query]=${encodeURIComponent(query)}&search[type]=1`
  );
}

function eventUrlByCard(slug, types) {
  // bycard URL события: /afisha/<city>/<type>/<slug>. Тип берём из первого
  // типа карточки (event/concert/show/…), запасной — 'event'.
  const type = (Array.isArray(types) && types[0] && types[0].slug) || 'event';
  return `${BYCARD_SITE}/afisha/minsk/${type}/${slug}`;
}

function venueUrlByCard(slug) {
  return `${BYCARD_SITE}/afisha/minsk/venues/${slug}`;
}

function parseSearchPayload(data) {
  const events = [];
  const venues = [];
  if (!data) return { events, venues };
  for (const p of data?.performances?.items || []) {
    if (!p?.slug || !p?.name) continue;
    events.push({
      source: 'afisha',
      uid: p.slug,
      title: p.name,
      url: `${SITE}/ru/minsk/event/${p.slug}`,
      image: p.image?.['300x430'] || p.image?.['240x340'] || p.image?.original || null,
    });
  }
  for (const o of data?.objects?.items || []) {
    if (!o?.slug || !o?.name) continue;
    venues.push({
      source: 'afisha',
      uid: o.slug,
      id: o.id ?? null,
      name: o.name,
      url: `${SITE}/ru/minsk/events/${o.slug}`,
      typeName: o.type?.name || null,
    });
  }
  return { events, venues };
}

// Поиск по ключевому слову на 24afisha.by и bycard.by, с дедупликацией по slug.
// Приоритет — 24afisha.by (канонический домен), bycard-only события получают
// bycard-URL.
// Устойчиво к недоступности одного хоста (например, если api.24afisha.by
// заблокирован с Droplet) — используем то, что ответило.
// Возвращает: { events: [{uid,title,url,image}], venues: [{uid,name,url,typeName}] }
export async function searchAfisha(query) {
  // bycard (abws.bycard.by) — общий бэкенд, доступен с Droplet; его ждём.
  // api.24afisha.by может быть заблокирован — не блокируем поиск: пробуем с
  // коротким таймаутом, но основной результат отдаём по bycard сразу.
  const bcP = httpJson(searchUrl(BYCARD_API, query)).catch(() => null);
  // Запускаем оба параллельно; результат отдаём как только bycard готов.
  const bc = await bcP;
  const af = await Promise.race([
    httpJson(searchUrl(API, query), { timeout: AFISHA_SHORT_TIMEOUT_MS }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)), // не ждём заблокированный хост дольше 1.5с
  ]);
  const afRes = parseSearchPayload(af ? af.data : null);
  const bcRes = parseSearchPayload(bc ? bc.data : null);

  const eventsMap = new Map();
  for (const ev of afRes.events) eventsMap.set(ev.uid, ev);
  for (const ev of bcRes.events) {
    if (eventsMap.has(ev.uid)) continue; // уже есть с канонического домена
    eventsMap.set(ev.uid, { ...ev, url: eventUrlByCard(ev.uid, undefined) });
  }

  const venuesMap = new Map();
  for (const v of afRes.venues) venuesMap.set(v.uid, v);
  for (const v of bcRes.venues) {
    if (venuesMap.has(v.uid)) continue;
    venuesMap.set(v.uid, { ...v, url: venueUrlByCard(v.uid) });
  }

  return { events: [...eventsMap.values()], venues: [...venuesMap.values()] };
}

// Детали события по странице (24afisha.by или bycard.by). pageUrl передаём в
// normalizeLdEvent — это канонический url события (у bycard в JSON-LD числовой id).
// При недоступности страницы (например, заблокирован 24afisha.by) возвращает null,
// не бросая ошибку — это фолбэк, основная логика идёт через schedule API.
export async function fetchAfishaEventDetails(eventUrl) {
  let page;
  try {
    page = await httpGet(eventUrl, { timeout: AFISHA_SHORT_TIMEOUT_MS });
  } catch {
    return null;
  }
  const { status, text, finalUrl } = page;
  if (status !== 200 || !text) return null;
  const ld = findEventLd(extractJsonLd(text));
  if (!ld) return null;
  return normalizeLdEvent(ld, 'afisha', finalUrl || eventUrl);
}

// Числовой id площадки из URL. Мини-приложение раньше добавляло его фильтром
// ?objectsIds=<id> — поддерживаем такие (переходные) ссылки.
export function afishaObjectIdFromUrl(url) {
  const m = /[?&]objectsIds=(\d+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

// Slug площадки из ссылки: /ru/object/<slug> (канонический вид) или старый
// /ru/<city>/events/<slug>.
export function afishaVenueSlugFromUrl(url) {
  const s = String(url || '');
  return /\/ru\/object\/([^\/?#]+)/.exec(s)?.[1]
    || /\/ru\/[a-z\-]+\/events\/([^\/?#]+)/.exec(s)?.[1]
    || '';
}

// Расписание площадки (киносеансы): GET /api/v2/schedule/objects/<id> →
// data[0] = { id, name, slug, cityId, events[] }. У кинотеатров афиша только здесь.
async function fetchAfishaScheduleObject(id) {
  if (!id) return null;
  for (const base of [BYCARD_API, API]) {
    try {
      const r = await httpJson(
        `${base}/api/v2/schedule/objects/${id}`,
        { timeout: AFISHA_SHORT_TIMEOUT_MS },
      );
      const item = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
      if (item) return item;
    } catch { /* пробуем следующий хост */ }
  }
  return null;
}

// Страница площадки: GET /api/v3/pages/objects/<slug> → { object, more[], … }.
// object — сама площадка (id/name/slug/cityId), more[] — мероприятия площадки
// (театр/концерты/филармония и т.п.) с сеансами. Старые «страницы площадок»
// /ru/<city>/events/<slug> на 24afisha.by отдают «Билеты в undefined» и пустой
// список — этот v3-источник им на замену.
async function fetchAfishaVenuePage(slug) {
  if (!slug) return null;
  for (const base of [BYCARD_API, API]) {
    try {
      const r = await httpJson(
        `${base}/api/v3/pages/objects/${encodeURIComponent(slug)}?cityId=0&lang=ru&slug=true&jsonld=0`,
        { timeout: AFISHA_SHORT_TIMEOUT_MS },
      );
      if (r.ok && r.data && r.data.object) return r.data;
    } catch { /* пробуем следующий хост */ }
  }
  return null;
}

// Сеанс → текст даты «ДД.ММ.ГГГГ ЧЧ:ММ». У кино дата/время приходят готовыми
// строками; у театра их нет — считаем из timeSpending (unix, Беларусь = UTC+3).
function afishaSessionDateText(session) {
  if (session.dateStr) return `${session.dateStr} ${session.timeStr || ''}`.trim();
  const ts = Number(session.timeSpending);
  if (!ts) return null;
  const d = new Date((ts + 3 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Цена сеанса в копейках → «42» / «42,5»; 0 → null.
function centsToByn(v) {
  const n = Number(v);
  return n ? String(n / 100).replace('.', ',') : null;
}

// Цена площадки — уже в BYN строкой: «55.00» → «55», «7.50» → «7,5»; 0 → null.
function decimalToByn(v) {
  const n = Number(v);
  if (!n) return null;
  return String(n).replace('.', ',');
}

/**
 * Площадка «афиши»: имя, город, slug и сырые списки мероприятий.
 * Мероприятия разных типов площадок лежат в разных источниках: киносеансы — в
 * schedule API (`events[]`), театр/концерты — в v3-странице площадки (`more[]`).
 * Возвращаем оба списка, чекер их объединяет.
 *
 * @param {string} venueRef URL площадки (/ru/object/<slug> или старая ссылка)
 * @returns {Promise<{id,name,slug,citySlug,schedEvents:object[],perfEvents:object[]}|null>}
 */
export async function fetchAfishaVenue(venueRef) {
  const idFromUrl = afishaObjectIdFromUrl(venueRef);
  const slugFromUrl = afishaVenueSlugFromUrl(venueRef);

  // v3-страница площадки по slug (объект + театральные/концертные мероприятия).
  let page = slugFromUrl ? await fetchAfishaVenuePage(slugFromUrl) : null;
  const id = idFromUrl || (page?.object?.id ?? null);

  // Расписание (киносеансы) по числовому id.
  const schedule = await fetchAfishaScheduleObject(id);

  // Переходные ссылки …/events/kino?objectsIds=<id>: slug из URL — не площадка,
  // берём настоящий slug из расписания и перечитываем страницу.
  if ((!page || !page.object) && schedule && schedule.slug) {
    page = await fetchAfishaVenuePage(schedule.slug);
  }

  const obj = page?.object || schedule;
  if (!obj && !schedule) return null;

  const cityIds = await afishaCityIds();
  const cityId = Number(obj?.cityId ?? schedule?.cityId);
  const citySlug = Object.keys(cityIds).find((k) => cityIds[k] === cityId)
    || afishaCityFromUrl(venueRef);

  return {
    id: obj?.id ?? id ?? null,
    name: obj?.name || schedule?.name || null,
    slug: obj?.slug || schedule?.slug || slugFromUrl || null,
    citySlug,
    schedEvents: Array.isArray(schedule?.events) ? schedule.events : [],
    perfEvents: Array.isArray(page?.more) ? page.more : [],
  };
}

// Одно мероприятие площадки → мини-карточка события. Нужен хотя бы один сеанс
// с открытой продажей (isSaleOpen).
function buildAfishaVenueEvent(ev, { venueName, citySlug }) {
  if (!ev || !ev.slug || !ev.name) return null;
  const session = (ev.sessions || []).find((s) => s && s.isSaleOpen);
  if (!session) return null;
  return {
    source: 'afisha',
    uid: `${ev.slug}@${citySlug}`,
    title: String(ev.name).trim(),
    venue: venueName,
    city: citySlug,
    dateText: afishaSessionDateText(session),
    startsAt: Number(session.timeSpending) || null,
    url: `${SITE}/ru/${citySlug}/event/${ev.slug}`,
    image: ev.image?.['300x430'] || ev.image?.original || null,
    priceFrom: centsToByn(session.minPrice) || decimalToByn(ev.minPrice),
    priceTo: centsToByn(session.maxPrice) || decimalToByn(ev.maxPrice),
    currency: 'BYN',
    onSale: true,
    status: 'onsale',
  };
}

/**
 * События площадки «афиши», по которым открыта продажа (для слежения за площадкой).
 * Объединяет киносеансы (schedule API) и мероприятия театра/концертов (v3-страница),
 * дедуп по uid.
 *
 * @param {string} venueRef URL площадки
 * @returns {Promise<{venue:object|null, events:object[]}>}
 */
export async function fetchAfishaVenueEvents(venueRef) {
  const venue = await fetchAfishaVenue(venueRef);
  if (!venue) return { venue: null, events: [] };
  const byUid = new Map();
  for (const ev of [...venue.schedEvents, ...venue.perfEvents]) {
    const built = buildAfishaVenueEvent(ev, { venueName: venue.name, citySlug: venue.citySlug });
    if (built && !byUid.has(built.uid)) byUid.set(built.uid, built);
  }
  return {
    venue: { id: venue.id, name: venue.name, slug: venue.slug, citySlug: venue.citySlug },
    events: [...byUid.values()],
  };
}

// Публичная страница площадки. Работает для всех типов площадок (в отличие от
// старого /ru/<city>/events/<slug>, который отдаёт «Билеты в undefined»).
export function afishaVenueListingUrl(venue) {
  if (!venue || !venue.slug) return null;
  return `${SITE}/ru/object/${venue.slug}`;
}

// Заменяет город-сегмент в URL события «афиши».
//   24afisha: /ru/<city>/event/<slug>
//   bycard:   /afisha/<city>/<type>/<slug>
// Возвращает тот же URL, если город распознать/заменить не удалось.
export function eventUrlForCity(eventUrl, city) {
  const s = String(eventUrl || '');
  if (!city || city === 'all') return s;
  const enc = encodeURIComponent(city);
  // 24afisha: /ru/<city>/event/<slug>
  const m24 = s.match(/^(https?:\/\/[^/]+)\/ru\/[^/]+\/((?:event|events)\/.*)$/);
  if (m24) return `${m24[1]}/ru/${enc}/${m24[2]}`;
  // bycard: /afisha/<city>/<type>/<slug>
  const mbc = s.match(/^(https?:\/\/[^/]+)\/afisha\/[a-z\-]+\/((?:event|concert|show|other)\/.*)$/);
  if (mbc) return `${mbc[1]}/afisha/${enc}/${mbc[2]}`;
  return s;
}

/**
 * Список городов для выбора слежения по событию.
 * Раньше парсил страницу события (блок «Доступно в городах»), но сервер (Droplet)
 * может быть заблокирован 24afisha.by — поэтому список берём из каталога городов
 * бэкенда (/api/v2/cities на abws.bycard.by), который доступен всегда. Возвращаем
 * текущий город события + полный список городов с URL на 24afisha.by.
 *
 * @param {string} eventUrl URL страницы события (24afisha.by или bycard.by)
 * @returns {Promise<{current:{slug,label,url}, cities:[{slug,label,url}]}|null>}
 */
export async function fetchEventCities(eventUrl) {
  const cityIds = await afishaCityIds();
  if (!cityIds || !Object.keys(cityIds).length) return null;

  const final = eventUrl;
  const currentSlug = /\/ru\/([a-z\-]+)\/(?:event|events)\//.exec(final)?.[1]
    || /\/afisha\/([a-z\-]+)\//.exec(final)?.[1]
    || 'minsk';

  const cities = Object.keys(cityIds).map((slug) => ({
    slug,
    label: slug,
    url: eventUrlForCity(final, slug),
  }));
  // Текущий город ставим первым.
  const cur = cities.find((c) => c.slug === currentSlug) || { slug: currentSlug, label: currentSlug, url: eventUrlForCity(final, currentSlug) };
  const rest = cities.filter((c) => c.slug !== currentSlug);
  const ordered = [cur, ...rest];

  return {
    current: { slug: currentSlug, label: currentSlug, url: cur.url },
    cities: ordered,
  };
}
