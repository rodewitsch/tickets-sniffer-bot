// Источник «Афиша» (24afisha.by и bycard.by — один общий бэкенд: общая база,
// одинаковые slug). Поиск ищет на обоих доменах и мёржит по slug; buy-ссылка
// ведёт на тот домен, где найдено событие.
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent } from '../normalize.js';

const API = 'https://api.24afisha.by';
const SITE = 'https://24afisha.by';
const BYCARD_API = 'https://abws.bycard.by';
const BYCARD_SITE = 'https://bycard.by';

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
// Возвращает: { events: [{uid,title,url,image}], venues: [{uid,name,url,typeName}] }
export async function searchAfisha(query) {
  const [af, bc] = await Promise.all([
    httpJson(searchUrl(API, query)),
    httpJson(searchUrl(BYCARD_API, query)),
  ]);

  const afRes = parseSearchPayload(af.data);
  const bcRes = parseSearchPayload(bc.data);

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
export async function fetchAfishaEventDetails(eventUrl) {
  const { status, text, finalUrl } = await httpGet(eventUrl);
  if (status !== 200 || !text) return null;
  const ld = findEventLd(extractJsonLd(text));
  if (!ld) return null;
  return normalizeLdEvent(ld, 'afisha', finalUrl || eventUrl);
}

// Ссылки на события площадки (для отслеживания площадки целиком).
// Обрабатываем оба формата URL событий «афиши».
export async function fetchVenueEventLinks(venueUrl) {
  const { status, text } = await httpGet(venueUrl);
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
