// Источник BezKassira.by (облачная система продажи билетов).
// Поиск — Sphinx через AJAX-эндпоинт /block/ (возвращает JSON {status, html}
// с блоками <div class="li">); детали события — schema.org Event из JSON-LD
// страницы события (имя, дата, площадка/город, диапазон цен, наличие, организатор).
// «Площадки» здесь — организаторы: следим за всеми событиями страницы /organises/….
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent } from '../normalize.js';
import { normText } from '../util.js';
import { CITY_LABELS } from '../cities.js';

const SITE = 'https://bezkassira.by';

// Канонический url события: без query/fragment и без хвостового слэша —
// используется как uid (стабильный ключ дедупликации в events).
function canonUrl(u) {
  return String(u || '').split(/[?#]/)[0].replace(/\/+$/, '');
}

// Страницы сайта требуют хвостовой слэш (без него — HTTP 403). Нормализуем вход.
function pageUrl(u) {
  const s = String(u || '').split(/[?#]/)[0];
  return /\/$/.test(s) ? s : s + '/';
}

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

const CITY_SET = new Set(Object.values(CITY_LABELS).map(normText));

// «ГУ «Дворец культуры…», Борисов» → venue + city (по последней запятой,
// если хвост — известный город из каталога).
function splitHint(hint) {
  const s = String(hint || '').trim();
  if (!s) return { venue: null, city: null };
  const i = s.lastIndexOf(',');
  if (i > 0) {
    const head = s.slice(0, i).trim();
    const tail = s.slice(i + 1).trim();
    if (CITY_SET.has(normText(tail))) return { venue: head || null, city: tail };
    return { venue: s, city: null };
  }
  return CITY_SET.has(normText(s)) ? { venue: null, city: s } : { venue: s, city: null };
}

// Разбор HTML-выдачи поиска: блоки <div class="li">.
function parseSearchHtml(html) {
  const out = [];
  if (!html) return out;
  const seen = new Set();
  for (const chunk of String(html).split('<div class="li">').slice(1)) {
    const clean = chunk.replace(/<!--[\s\S]*?-->/g, '');
    const img = /<img[^>]*src="([^"]+)"/.exec(clean)?.[1] || null;
    const links = [...clean.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const url = links[0] ? canonUrl(links[0][1]) : null;
    let title = null;
    for (const l of links) {
      const t = decodeEntities(l[2].replace(/<[^>]+>/g, '')).replace(/^"(.*)"$/, '$1');
      if (t) { title = t; break; }
    }
    const hint = decodeEntities(/<div class="hint">([\s\S]*?)<\/div>/.exec(clean)?.[1] || '');
    if (!url || !title) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const { venue, city } = splitHint(hint);
    out.push({ source: 'bezkassira', uid: url, title, url, image: img, venue, city });
  }
  return out;
}

// Поиск по ключевому слову (как живой дропдаун на сайте).
export async function searchBezkassira(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `${SITE}/block/?process=activity.sphinx_search&action=search_main&query=${encodeURIComponent(q)}`;
  const { ok, data } = await httpJson(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!ok || !data || data.status !== 0 || !data.html) return [];
  return parseSearchHtml(data.html);
}

// Детали события по его странице (JSON-LD schema.org Event).
export async function fetchBezkassiraEventDetails(eventUrl) {
  let page;
  try {
    page = await httpGet(pageUrl(eventUrl));
  } catch {
    return null;
  }
  const { status, text, finalUrl } = page;
  if (status !== 200 || !text) return null;
  const ld = findEventLd(extractJsonLd(text));
  if (!ld) return null;
  const ev = normalizeLdEvent(ld, 'bezkassira', finalUrl || pageUrl(eventUrl));
  if (!ev) return null;
  ev.uid = canonUrl(ev.url);
  ev.url = canonUrl(ev.url);
  // Цены в JSON-LD «35.00» — приводим к виду «35,00» (как у остальных источников).
  const fmtPrice = (p) => (p == null ? null : String(p).replace('.', ','));
  ev.priceFrom = fmtPrice(ev.priceFrom);
  ev.priceTo = fmtPrice(ev.priceTo);
  return ev;
}

// Организатор события (для отслеживания «площадки»): имя + url /organises/….
export async function fetchBezkassiraOrganizer(eventUrl) {
  let page;
  try {
    page = await httpGet(pageUrl(eventUrl));
  } catch {
    return null;
  }
  const { status, text } = page;
  if (status !== 200 || !text) return null;
  const ld = findEventLd(extractJsonLd(text));
  if (!ld || !ld.organizer || !ld.organizer.url) return null;
  return {
    name: ld.organizer.name || null,
    url: canonUrl(ld.organizer.url),
  };
}

// События организатора (страница /organises/…): ссылки на события с первой страницы.
export async function fetchBezkassiraOrganizerEventLinks(orgUrl) {
  let page;
  try {
    page = await httpGet(pageUrl(orgUrl));
  } catch {
    return [];
  }
  const { status, text } = page;
  if (status !== 200 || !text) return [];
  const links = [];
  const seen = new Set();
  const re = /href="(https:\/\/bezkassira\.by\/[a-z0-9\-]+-\d+\/)"/g;
  for (const m of text.matchAll(re)) {
    const u = canonUrl(m[1]);
    if (seen.has(u)) continue;
    seen.add(u);
    links.push({ url: u, source: 'bezkassira' });
  }
  return links;
}
