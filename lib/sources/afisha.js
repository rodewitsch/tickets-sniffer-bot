// Источник «Афиша» (24afisha.by и bycard.by — один общий бэкенд: общая база,
// одинаковые slug). Поиск ищет на обоих доменах и мёржит по slug; buy-ссылка
// ведёт на тот домен, где найдено событие.
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent, afishaSlugFromUrl } from '../normalize.js';
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

// Ссылки на события площадки (для отслеживания площадки целиком).
// Обрабатываем оба формата URL событий «афиши».
// При недоступности страницы (заблокирован хост) возвращает [] — не бросает.
export async function fetchVenueEventLinks(venueUrl) {
  let page;
  try {
    page = await httpGet(venueUrl, { timeout: AFISHA_SHORT_TIMEOUT_MS });
  } catch {
    return [];
  }
  const { status, text } = page;
  if (status !== 200 || !text) return [];
  const links = [];
  const seen = new Set();
  const hrefRe = /href="((?:\/ru\/[a-z\-]+\/event\/|\/afisha\/[a-z\-]+\/[a-z\-]+\/)[^"?#]+)"/g;
  for (const m of text.matchAll(hrefRe)) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const host = path.startsWith('/afisha/') ? BYCARD_SITE : SITE;
    links.push({ url: host + path, source: 'afisha' });
  }
  return links;
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

// Заменяет город-сегмент в URL площадки «афиши»: /ru/<city>/events/<slug>.
export function venueUrlForCity(venueUrl, city) {
  const s = String(venueUrl || '');
  if (!city || city === 'all') return s;
  const enc = encodeURIComponent(city);
  const m = s.match(/^(https?:\/\/[^/]+)\/ru\/[^/]+\/(events\/.*)$/);
  return m ? `${m[1]}/ru/${enc}/${m[2]}` : s;
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
