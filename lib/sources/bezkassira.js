// Источник BezKassira.by (облачная система продажи билетов).
// Поиск — Sphinx через AJAX-эндпоинт /block/ (возвращает JSON {status, html}
// с блоками <div class="li">); детали события — schema.org Event из JSON-LD
// страницы события (имя, дата, площадка/город, диапазон цен, наличие, организатор).
// «Площадки» здесь — организаторы: следим за всеми событиями страницы /organises/….
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent } from '../normalize.js';
import { normText, textMatchesQuery } from '../util.js';
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

// Категория (кино/театр/концерт/…) и детали (дата/цены) в выдаче поиска BezKassira
// не выводятся, а URL события плоский (без раздела). Раздел есть только в хлебных
// крошках страницы события: «Афиша › <Категория> [в городе] › … › событие», где
// ссылка категории ведёт на /events/<slug>[-<город>]/…; дата и цены — в JSON-LD
// страницы. Чтобы карточки Mini App показывали их, как у Ticketpro, живой поиск
// обогащает результаты: открывает страницу события и за один заход берёт и раздел,
// и JSON-LD-детали. Кэш по URL на несколько часов, чтобы повторные нажатия не
// дёргали сайт.
let bezkassiraDetail = new Map(); // url -> { category, dateText, startsAt, priceFrom, priceTo, currency, at }
const BEZKASSIRA_DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
const BEZKASSIRA_DETAIL_MAX = 500;
const BEZKASSIRA_ENRICH_LIMIT = 10;
const BEZKASSIRA_ENRICH_CONCURRENCY = 3;

// Общественные разделы BezKassira (slug-префикс URL → тип). Слаги используют «_»
// (не «-»), город добавляется суффиксом «-<город>», напр. /events/concert-minsk/.
const BEZKASSIRA_CATS = [
  ['concert', 'Концерт'],
  ['istoriya_i_lichnosti', 'Лекция'],
  ['kino', 'Кино'],
  ['teatry', 'Театр'],
  ['iskusstvo_i_kultura', 'Искусство'],
  ['exhibition', 'Выставка'],
  ['festival', 'Фестиваль'],
  ['sport_event', 'Спорт'],
  ['dlya_detey', 'Детям'],
  ['quests_and_quizzes', 'Квесты'],
  ['party', 'Вечеринка'],
  ['online', 'Онлайн'],
  ['ekskursii_i_puteshestviya', 'Экскурсия'],
  ['education_and_development', 'Обучение'],
  ['krasota_i_zdorovie', 'Красота и здоровье'],
  ['psihologiya_i_samopoznanie', 'Психология'],
  ['biznes', 'Бизнес'],
  ['it_i_internet', 'ИТ'],
  ['new_year', 'Новый год'],
  ['sertificati', 'Сертификат'],
  ['drugie_razvlecheniya', 'Развлечение'],
  ['drugie_sobytiya', 'Разное'],
];

function bezkassiraCatLabelFromSlug(seg) {
  const s = String(seg || '');
  for (const [slug, label] of BEZKASSIRA_CATS) {
    // Сегмент — это '<slug>' или '<slug>-<город>'. Слаги содержат '_', поэтому
    // сравнение с префиксом '<slug>-' не ловит чужие разделы.
    if (s === slug || s.startsWith(`${slug}-`)) return label;
  }
  return null;
}

function mapLimitBez(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { items[idx] = await fn(items[idx]); } catch { items[idx] = null; }
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => items);
}

// Читает раздел события из хлебных крошек страницы: берём первую ссылку-раздел
// (после «Афиша»), ведущую на /events/<slug>[<город>]/, и переводим в тип.
function categoryFromBezkassiraPage(text) {
  const m = /<div class="breadcrumbs">([\s\S]*?)<\/div>/.exec(text || '');
  if (!m) return null;
  for (const a of m[1].matchAll(/<a\b[^>]*href="([^"]*\/events\/([^/"]+)\/)"[^>]*>/g)) {
    const seg = a[2];
    const label = bezkassiraCatLabelFromSlug(seg);
    if (label) return label;
  }
  return null;
}

// Цены в JSON-LD «35.00» — приводим к виду «35,00» (как у остальных источников).
function fmtBezPrice(p) {
  return p == null ? null : String(p).replace('.', ',');
}

// Поля события со страницы за один HTTP-заход: раздел (breadcrumbs) + JSON-LD
// детали (дата, цены). Возвращает кэшированный объект (не null), чтобы повторные
// нажатия в поиске не дёргали сайт.
async function fetchBezkassiraDetail(eventUrl) {
  const url = canonUrl(eventUrl);
  if (!url) return { category: null, dateText: null, startsAt: null, priceFrom: null, priceTo: null, currency: null };
  const hit = bezkassiraDetail.get(url);
  if (hit && Date.now() - hit.at < BEZKASSIRA_DETAIL_TTL_MS) return hit;
  let base = { category: null, dateText: null, startsAt: null, priceFrom: null, priceTo: null, currency: null };
  try {
    const { status, text, finalUrl } = await httpGet(pageUrl(url));
    if (status === 200 && text) {
      const category = categoryFromBezkassiraPage(text);
      let dateText = null, startsAt = null, priceFrom = null, priceTo = null, currency = 'BYN';
      const ld = findEventLd(extractJsonLd(text));
      if (ld) {
        const ev = normalizeLdEvent(ld, 'bezkassira', finalUrl || pageUrl(url));
        if (ev) {
          dateText = ev.dateText || null;
          startsAt = ev.startsAt || null;
          priceFrom = fmtBezPrice(ev.priceFrom);
          priceTo = fmtBezPrice(ev.priceTo);
          currency = ev.currency || 'BYN';
        }
      }
      base = { category, dateText, startsAt, priceFrom, priceTo, currency };
    }
  } catch { /* сеть — оставляем пустые поля */ }
  if (bezkassiraDetail.size >= BEZKASSIRA_DETAIL_MAX) {
    const oldest = bezkassiraDetail.keys().next().value;
    bezkassiraDetail.delete(oldest);
  }
  bezkassiraDetail.set(url, { ...base, at: Date.now() });
  return bezkassiraDetail.get(url);
}

// Обогащает результаты поиска типом события и деталями (дата/цены) — открывает
// страницу каждого события за один заход (с кэшем по URL). Порядок сохраняется;
// поля, которые не удалось достать, остаются null.
export async function enrichBezkassiraDetails(cards) {
  const shown = (Array.isArray(cards) ? cards : []).slice(0, BEZKASSIRA_ENRICH_LIMIT);
  const results = await mapLimitBez(
    shown.map((e) => e && e.url).filter(Boolean),
    BEZKASSIRA_ENRICH_CONCURRENCY,
    (u) => fetchBezkassiraDetail(u),
  );
  let j = 0;
  return shown.map((e) => {
    const g = e && e.url ? results[j] : null;
    if (e && e.url) j++;
    return {
      ...e,
      category: (g && g.category) || null,
      dateText: (g && g.dateText) || null,
      startsAt: (g && g.startsAt) || null,
      priceFrom: (g && g.priceFrom) || null,
      priceTo: (g && g.priceTo) || null,
      currency: (g && g.currency) || null,
    };
  });
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
    const url = links[0] ? pageUrl(links[0][1]) : null;
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
    out.push({ source: 'bezkassira', uid: canonUrl(url), title, url, image: img, venue, city });
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
  const found = parseSearchHtml(data.html);
  // При нуле совпадений Sphinx отдаёт случайные события — отсекаем их
  // клиентски по пересечению токенов запроса с полями события.
  return found.filter((e) => textMatchesQuery(q, e.title, e.venue, e.city));
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
  ev.url = pageUrl(ev.url);
  ev.uid = canonUrl(ev.url);
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
    url: pageUrl(ld.organizer.url),
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
    links.push({ url: pageUrl(m[1]), uid: u, source: 'bezkassira' });
  }
  return links;
}
