// Источник «Афиша» (24afisha.by и bycard.by — один общий бэкенд: общая база,
// одинаковые slug). Поиск ищет на обоих доменах и мёржит по slug; buy-ссылка
// ведёт на тот домен, где найдено событие.
import { httpJson, httpGet } from '../http.js';
import { extractJsonLd, findEventLd } from '../jsonld.js';
import { normalizeLdEvent, afishaSlugFromUrl, afishaCityFromUrl } from '../normalize.js';
import { normText } from '../util.js';
import { cityLabel } from '../cities.js';
import { MAX_CITY_PROBES, AFISHA_SHORT_TIMEOUT_MS, AFISHA_SECONDARY_WAIT_MS } from '../config.js';

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
//
// ВАЖНО: regex обязан понимать ОБА формата URL, иначе id не извлекается и
// запрос уходит на `/schedule/events/null`:
//   • 24afisha: /ru/<city>/event/<slug>
//   • bycard:   /afisha/<city>/<type>/<slug>   (так хранятся позиции «афиши»
//     после починки битых страниц, см. afishaWorkingEventUrl — по факту это
//     ОСНОВНОЙ вид ссылки в базе).
// Без второй ветки каждый такой вызов делал два запроса к несуществующему
// событию (2 хоста × таймаут) и всегда возвращал onSale=false — событие в
// продаже никогда не проверялось, а цикл растягивался на 8–18 с на позицию
// (в проде: slow-item phases={"detail.afisha":13071}).
function afishaEventIdFromSlug(urlOrSlug) {
  const slug = /\/ru\/[a-z\-]+\/(?:event|events)\/([^\/?#]+)/.exec(String(urlOrSlug))?.[1]
    || /\/afisha\/[a-z\-]+\/(?:[a-z\-]+\/)?([^\/?#]+)/.exec(String(urlOrSlug))?.[1]
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
      // Короткий таймаут: два хоста последовательно, а без него каждый висел
      // бы до 9 с дефолтного FETCH_TIMEOUT_MS на ПЕРВОМ же вызове цикла.
      const { ok, data } = await httpJson(`${base}/api/v2/cities`, { timeout: AFISHA_SHORT_TIMEOUT_MS });
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

// Данные события через API abws.bycard.by — БЕЗ сайта и БЕЗ поиска.
//
// Зачем: страницы событий на bycard.by/24afisha.by с Droplet НЕДОСТУПНЫ (TCP на
// 178.172.160.176 не проходит, работает только abws на 178.172.148.47), а
// bycard-слаги вида `tsvety-dlya-eldzhernona-4` не содержат числового id, нужного
// schedule API. Раньше в этом случае шли в JSON-LD страницы → 2×4 с таймаута и
// гарантированный onSale=false: событие в продаже НИКОГДА не проверялось.
//
// `GET /api/v3/pages/events/<slug>` отдаёт всё, что нужно карточке: id,
// isSelling, nearSession (дата/сеанс/теги «Продано»), calendar (все даты),
// objects[0] (площадка), картинку. Замер на проде — 367–472 мс.
// Поиск по латинскому слагу здесь НЕ работает (находит 0) — и не нужен: слага
// события уже лежит в URL позиции.
const eventPageCache = new Map();
const EVENT_PAGE_CACHE_MAX = 1000;

async function afishaEventPage(slug) {
  if (!slug) return null;
  if (eventPageCache.has(slug)) return eventPageCache.get(slug);
  let page = null;
  try {
    const r = await httpJson(
      `${BYCARD_API}/api/v3/pages/events/${encodeURIComponent(slug)}?cityId=0&lang=ru&slug=true&jsonld=0`,
      { timeout: AFISHA_SHORT_TIMEOUT_MS },
    );
    if (r.ok && r.data && r.data.performance) page = r.data;
  } catch { /* нет сети — вернём null, как и раньше */ }
  if (eventPageCache.size >= EVENT_PAGE_CACHE_MAX) {
    const oldest = eventPageCache.keys().next().value;
    if (oldest !== undefined) eventPageCache.delete(oldest);
  }
  eventPageCache.set(slug, page);
  return page;
}

// Карточка уведомления из ответа /api/v3/pages/events/<slug>. Возвращает форму
// того же вида, что и остальные источники (source/uid/title/…), либо null если у
// события нет ни одного сеанса с открытой продажей.
function eventCardFromPage(page, eventUrl, citySlug) {
  const p = page && page.performance;
  if (!p) return null;
  const sessions = [];
  // Сеансы лежят в calendar/schedule, но надёжнее — в objects[].sessions
  // (формат тот же, что у schedule API). nearSession — запасной вариант.
  for (const o of page.objects || []) {
    for (const s of o.sessions || []) sessions.push(s);
  }
  if (!sessions.length && p.nearSession) sessions.push(p.nearSession);
  const nowSec = Math.floor(Date.now() / 1000);
  const open = sessions.filter((s) =>
    afishaSessionOnSale(s) && !(Number(s.timeSpending) && Number(s.timeSpending) < nowSec));
  if (!open.length) return null;
  open.sort((a, b) => (Number(a.timeSpending) || Infinity) - (Number(b.timeSpending) || Infinity));
  const nearest = open[0];
  const citySlugFor = (nearest.object && nearest.object.city && nearest.object.city.slug)
    || (p.types && p.types[0] && p.types[0].slug === 'theatre' ? citySlug : null)
    || citySlug || 'minsk';
  const venue = (nearest.object && nearest.object.name) || null;
  return {
    source: 'afisha',
    uid: `${afishaSlugFromUrl(eventUrl)}@${citySlugFor}`,
    title: p.name || '',
    venue,
    city: citySlugFor,
    dateText: afishaSessionDateText(nearest),
    extraDates: afishaOpenDates(open)
      .filter((d) => d !== afishaSessionDayKey(nearest))
      .slice(0, MAX_DATES_IN_CARD)
      .map(shortDayKey),
    startsAt: Number(nearest.timeSpending) || null,
    url: eventUrlForCity(eventUrl, citySlugFor),
    image: (p.image && (p.image['240x340'] || p.image.original)) || null,
    priceFrom: p.minPrice ? String(Number(p.minPrice)).replace('.', ',') : null,
    priceTo: p.maxPrice ? String(Number(p.maxPrice)).replace('.', ',') : null,
    currency: 'BYN',
    onSale: true,
    status: 'onsale',
  };
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
export async function fetchAfishaCityAvailability(eventUrl, citySlug, onProbe) {
  const eventId = afishaEventIdFromSlug(eventUrl);
  // Нет числового id в слаге (bycard-формат `tsvety-dlya-eldzhernona-4`) — идём в
  // страницу события через API abws. Сайт bycard.by с Droplet недоступен, а
  // schedule API без id не поможет; `pages/events/<slug>` отдаёт и id, и сеансы,
  // и всё для карточки за 370–470 мс (замер на проде).
  if (!eventId) {
    const slug = afishaSlugFromUrl(eventUrl);
    const page = await afishaEventPage(slug);
    if (!page) return { onSale: false, event: null, citySlug };
    const card = eventCardFromPage(page, eventUrl, citySlug);
    if (!card) return { onSale: false, event: null, citySlug };
    // Если запрошен конкретный город — сверяем фактический город события.
    if (citySlug && citySlug !== 'all' && card.city && !afishaCityLabelMatches(card.city, citySlug)) {
      return { onSale: false, event: null, citySlug };
    }
    if (typeof onProbe === 'function') onProbe();
    return { onSale: true, event: card, citySlug: card.city || citySlug };
  }
  const cityIds = await afishaCityIds();
  const targets = citySlug === 'all'
    ? Object.values(cityIds).slice(0, MAX_CITY_PROBES)
    : [cityIds[citySlug]].filter(Boolean);
  // Каждый опрошенный город сообщаем наружу — для учёта MAX_CITY_PROBES в статистике.
  const probe = () => { if (typeof onProbe === 'function') onProbe(); };

  // Пробуем schedule API: один запрос на город, стоп на первом onSale.
  // `time` + `ignoreEndTime=1` — так запрашивает расписание сам сайт: без них
  // API отдаёт ТОЛЬКО сегодняшние сеансы, а с ними — все сеансы от указанного
  // времени (десятки записей на несколько дней вперёд, начиная с сегодня; обычно
  // 2–3 дня). Без этого шанса получить несколько дат не было бы вовсе.
  for (const cityId of targets) {
    let fetched = null;
    // Предпочитаем abws.bycard.by (доступен с Droplet), затем api.24afisha.by.
    // probe() — один раз на город (после успешного ответа), а не на каждую попытку
    // хоста: иначе город с фолбэком на второй хост считался бы двумя проверками
    // и «макс. городов на проверку» завышался бы вдвое.
    const dayStart = Math.floor((Date.now() - 3 * 3600 * 1000) / 86400000) * 86400;
    for (const base of [BYCARD_API, API]) {
      try {
        // Короткий таймаут ОБЯЗАТЕЛЕН. Без него работал дефолт FETCH_TIMEOUT_MS
        // (9 с), а хостов два и они идут последовательно: зависший первый хост
        // давал до 18 с на ОДНУ позицию. В проде четыре минских события стабильно
        // занимали 13 с каждое (slow-item: phases={"detail.afisha":13134}) и сами
        // растягивали медиану цикла со ~7 с до 149 с. Это короткий вспомогательный
        // запрос (второй хост — запасной), ждать его 9 с незачем: 4 с хватает,
        // а не уложились — идём на запасной хост.
        const r = await httpJson(
          `${base}/api/v2/schedule/events/${eventId}?cityId=${cityId}&time=${dayStart}&ignoreEndTime=1`,
          { timeout: AFISHA_SHORT_TIMEOUT_MS },
        );
        if (r.ok && r.data) { fetched = r.data; probe(); break; }
      } catch { /* пробуем следующий хост */ }
    }
    if (!fetched) continue;
    const data = fetched;
    const item = data.data && data.data[0];
    if (!item || !Array.isArray(item.objects)) continue;
    for (const o of item.objects) {
      const nowSec = Math.floor(Date.now() / 1000);
      const sessions = (o.sessions || []).filter((s) => afishaSessionOnSale(s) && !(Number(s.timeSpending) && Number(s.timeSpending) < nowSec));
      if (!sessions.length) continue;
      // Один сеанс — одно событие (один dedupeKey, одна карточка). Поэтому event
      // собираем по БЛИЖАЙШЕМУ сеансу, а остальные даты с продажей просто
      // перечисляем: так человек видит, что билеты есть не на одну дату.
      const nearest = sessions.slice()
        .sort((a, b) => (Number(a.timeSpending) || Infinity) - (Number(b.timeSpending) || Infinity))[0];
      // Собираем мини-карточку события для уведомления.
      const citySlugFor = Object.keys(cityIds).find((k) => cityIds[k] === cityId) || citySlug;
      const ev = {
        source: 'afisha',
        uid: `${afishaSlugFromUrl(eventUrl)}@${citySlugFor}`,
        title: item.name || '',
        venue: o.name || null,
        city: citySlugFor,
        dateText: afishaSessionDateText(nearest),
        // Даты, на которые билеты уже есть. Количество мест сайт не отдаёт,
        // поэтому показываем именно даты: «ещё есть на 28.11 · 29.11».
        extraDates: afishaOpenDates(o.sessions)
          .filter((d) => d !== afishaSessionDayKey(nearest))
          .slice(0, MAX_DATES_IN_CARD)
          .map(shortDayKey),
        // timeSpending — unix-время начала (Беларусь). Без него startsAt был
        // null, и ключ антидубля/заглушки получал «nodate», хотя дата в
        // карточке есть. Кнопка «Больше не уведомлять» восстанавливала день из
        // карточки — ключи расходились, и заглушка не срабатывала.
        startsAt: Number(nearest.timeSpending) || null,
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
    // Город «тихий» — сеансов с продажей нет. В режиме «все города» идём дальше
    // к следующему городу (else — только запрошенный город, искать больше негде).
    if (citySlug !== 'all') return { onSale: false, event: null, citySlug };
  }

  // Нет числового id события → fallback на JSON-LD страницы города (Event с offers).
  const pageUrl = citySlug && citySlug !== 'all' ? eventUrlForCity(eventUrl, citySlug) : eventUrl;
  const ev = await fetchAfishaEventDetails(pageUrl);
  if (!ev || !ev.onSale) return { onSale: false, event: null, citySlug };
  // Страница города может редиректить на реальный город события (у «афиши» одно
  // событие живёт по одному URL на город). Если запрошен конкретный город, а
  // событие оказалось в другом — это НЕ совпадение: иначе могилёвский спектакль,
  // найденный по ссылке /afisha/minsk/…, уходил бы на «минскую» позицию.
  // Сверяем фактический город события (JSON-LD addressLocality) с запрошенным.
  if (citySlug && citySlug !== 'all' && ev.city && !afishaCityLabelMatches(ev.city, citySlug)) {
    return { onSale: false, event: null, citySlug };
  }
  return { onSale: true, event: ev, citySlug };
}

// Совпадает ли город события с запрошенным слагом. В schedule-пути ev.city — это
// слаг ('minsk'), в JSON-LD-фолбэке — метка из addressLocality ('Минск'), поэтому
// принимаем оба представления: сравниваем и с меткой каталога (cityLabel), и с
// самим слагом. Учитываем, что 'Ё' в метках на сайте может писаться как 'Е'
// («Могилевский» вместо «Могилёвский»).
function afishaCityLabelMatches(eventCity, citySlug) {
  const got = normText(eventCity);
  if (!got) return false;
  const wantSlug = normText(citySlug);
  const wantLabel = normText(cityLabel(citySlug));
  const norm = (s) => s.replace(/ё/g, 'е');
  return norm(got) === norm(wantSlug) || norm(got) === norm(wantLabel);
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
      // Каноническая публичная страница площадки. Старая /ru/<city>/events/<slug>
      // «битая» (title «Билеты в undefined»), поэтому ссылку строим на /ru/object/.
      // Город в slug уже зашит (kinoteatr-mir-brest-brest), так что /minsk/ не мешает.
      url: `${SITE}/ru/object/${o.slug}`,
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
  // api.24afisha.by с Droplet НЕ отвечает (проверено: 4 с таймаута на каждом
  // запросе, при рабочем 200 у bycard). Поэтому он — только «бонус»: держим
  // его в общем гонке с ЖЁСТКИМ лимитом AFISHA_SECONDARY_WAIT_MS, а не ждём
  // таймаут целиком.
  //
  // Раньше здесь было ДВЕ ошибки, и обе растягивали цикл:
  //   1. `await bcP` стоял ДО создания второго запроса — хосты шли не
  //      параллельно, как обещал комментарий, а последовательно;
  //   2. `Promise.race` с 1.5 с ждал таймер ПОСЛЕ bycard: даже при ответе
  //      bycard за 100 мс функция висела 1.5 с.
  // В проде это давало 1.7–2.7 с на КАЖДЫЙ промах кэша (60 промахов/цикл =
  // ~150 с) — та самая медиана 149 с. Теперь: оба запроса стартуют сразу,
  // bycard решает, второй хост добавляется только если успел за лимит.
  const bcP = httpJson(searchUrl(BYCARD_API, query), { timeout: AFISHA_SHORT_TIMEOUT_MS }).catch(() => null);
  // Стартуем ОДНОВРЕМЕННО с bycard и гасим ожидание таймером, который очищается.
  const afP = httpJson(searchUrl(API, query), { timeout: AFISHA_SHORT_TIMEOUT_MS }).catch(() => null);
  let timer;
  const afTimeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), AFISHA_SECONDARY_WAIT_MS); });
  const [bc, af] = await Promise.all([
    bcP,
    Promise.race([afP, afTimeout]).finally(() => clearTimeout(timer)),
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

// Slug площадки из ссылки. Поддерживаем ТРИ вида:
//   /ru/object/<slug>                    — канонический (24afisha.by и bycard.by)
//   /afisha/<city>/venues/<slug>         — bycard-ссылка (её строит venueUrlByCard,
//                                          когда поиск ответил только bycard)
//   /ru/<city>/events/<slug>             — старый (битый) вид, для совместимости
//
// Без второй ветки bycard-ссылки давали пустой slug, и fetchAfishaVenueEvents
// молча возвращал venue=null. В проде из-за этого залипли все площадки,
// найденные только через bycard (9 записей очереди с failing=1).
export function afishaVenueSlugFromUrl(url) {
  const s = String(url || '');
  return /\/ru\/object\/([^\/?#]+)/.exec(s)?.[1]
    || /\/afisha\/[a-z\-]+\/venues\/([^\/?#]+)/.exec(s)?.[1]
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

// Сколько будущих дат с открытой продажей показывать в карточке уведомления.
// Сайт не отдаёт количество оставшихся мест, зато отдаёт СПИСОК сеансов — это
// единственное, что реально можно показать человеку («билеты есть на эти даты»).
const MAX_DATES_IN_CARD = 3;

// Открыт ли сеанс к продаже с учётом тега «Продано».
// `isSaleOpen` может остаться true у распроданного сеанса — у него в tags
// приходит { id: 51, name: 'Продано' }. Прочие теги (2D и т.п.) не мешают.
function afishaSessionOnSale(session) {
  if (!session || !session.isSaleOpen) return false;
  const tags = Array.isArray(session.tags) ? session.tags : [];
  return !tags.some((t) => t && String(t.name || '').toLowerCase().includes('продано'));
}

// Все БУДУЩИЕ даты (без времени) с открытой продажей → ['28.11', '29.11', …].
// Сайт держит в выдаче прошедшие сеансы, поэтому их отсекаем: иначе в карточке
// оказалась бы вчерашняя дата.
function afishaOpenDates(sessions, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!afishaSessionOnSale(s)) continue;
    const ts = Number(s.timeSpending) || null;
    if (ts && ts < now) continue;
    const dmy = afishaSessionDayKey(s);
    if (dmy && !out.includes(dmy)) out.push(dmy);
  }
  return out;
}

// 'ДД.ММ.ГГГГ' из сеанса: dateStr есть у кино, у театра считаем из timeSpending.
function afishaSessionDayKey(session) {
  const m = /(\d{2}\.\d{2}\.\d{4})/.exec(String(session.dateStr || ''));
  if (m) return m[1];
  const ts = Number(session.timeSpending);
  if (!ts) return null;
  return dayKeyFromTs(ts);
}

// unix (Беларусь = UTC+3) → 'ДД.ММ.ГГГГ'.
function dayKeyFromTs(ts) {
  const d = new Date((Number(ts) + 3 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

// 'ДД.ММ.ГГГГ' → 'ДД.ММ' (для строки «ещё даты» — год в ней лишний).
function shortDayKey(dmy) {
  return dmy.replace(/^(\d{2}\.\d{2})\.\d{4}$/, '$1');
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
  const nowSec = Math.floor(Date.now() / 1000);
  const session = (ev.sessions || []).find((s) => afishaSessionOnSale(s) && !(Number(s.timeSpending) && Number(s.timeSpending) < nowSec));
  if (!session) return null;
  return {
    source: 'afisha',
    uid: `${ev.slug}@${citySlug}`,
    title: String(ev.name).trim(),
    venue: venueName,
    city: citySlug,
    dateText: afishaSessionDateText(session),
    // Прочие даты с продажей — «билеты есть и на …». Количество мест сайт не
    // отдаёт, поэтому показываем именно даты.
    extraDates: afishaOpenDates(ev.sessions)
      .filter((d) => d !== afishaSessionDayKey(session))
      .slice(0, MAX_DATES_IN_CARD)
      .map(shortDayKey),
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

// Ссылка на то же событие на bycard.by (общий с 24afisha бэкенд). Формат
// /afisha/<city>/event/<slug> — сегмент типа не проверяется сайтом.
export function afishaEventUrlByCard(eventUrl) {
  const slug = afishaSlugFromUrl(eventUrl);
  const city = afishaCityFromUrl(eventUrl) || 'minsk';
  if (!slug) return String(eventUrl || '');
  return `${BYCARD_SITE}/afisha/${city}/event/${slug}`;
}

// Кэш «страница события открывается» (по URL), чтобы не проверять повторно.
const eventPageOkCache = new Map();

/**
 * Рабочая (открывающаяся) ссылка на событие «афиши». Часть страниц событий на
 * 24afisha.by падает в SSR (HTTP 500, «Server error») — например, из-за отзывов.
 * Если канонический URL не открывается, подменяем на то же событие на bycard.by
 * (общий бэкенд, страница работает). Не-афишные и bycard-ссылки возвращаем как есть.
 * Результат проверки кэшируется в памяти процесса.
 *
 * @param {string} eventUrl URL страницы события
 * @returns {Promise<string>} рабочая ссылка
 */
export async function afishaWorkingEventUrl(eventUrl) {
  const s = String(eventUrl || '');
  if (!s || /bycard\.by/i.test(s) || !/24afisha\.by/i.test(s)) return s;
  let ok = eventPageOkCache.get(s);
  if (ok === undefined) {
    try {
      const r = await httpGet(s, { timeout: AFISHA_SHORT_TIMEOUT_MS });
      ok = r.status === 200;
    } catch {
      ok = false;
    }
    eventPageOkCache.set(s, ok);
  }
  return ok ? s : afishaEventUrlByCard(s);
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
