// Цикл проверки: поиск отслеживаемых позиций в источниках, апсерт событий,
// уведомления о появлении билетов.
import db from '../db.js';
import { api } from '../api.js';
import { events, notifications, checkLog, meta } from '../schema.js';
import { eq, and, sql } from '../db.js';
import { CHECK_INTERVAL_MIN, DETAIL_BUDGET, VENUE_BUDGET_RESERVE, MAX_VENUE_RESULTS_PER_QUERY, MAX_VENUE_EVENTS, VENUE_CRAWL_BUDGET_MS, VENUE_QUERY_RECHECK_MS, DETAIL_BUDGET_MIN_PER_CHAT, PRIORITIZE_STALE, RECHECK_PRESALE_HORIZON_DAYS } from './config.js';
import { activeWatchItems, updateWatchItemLocation } from './watch.js';
import { cachedSearch, resetSearchCacheStats, snapshotSearchCacheStats } from './search-cache.js';
import { searchAfisha, fetchAfishaCityAvailability, fetchAfishaVenue, fetchAfishaVenueEvents, afishaVenueListingUrl, afishaWorkingEventUrl } from './sources/afisha.js';
import { searchTicketpro, fetchTicketproEventDetails, fetchTicketproVenueEventLinks } from './sources/ticketpro.js';
import { searchBezkassira, fetchBezkassiraEventDetails, fetchBezkassiraOrganizerEventLinks } from './sources/bezkassira.js';
import { afishaUidForCity, afishaCityFromUrl } from './normalize.js';
import { cityLabel, venueCityFromSlug, citySlugFrom } from './cities.js';
import { ticketCaption, ticketKeyboard } from './menus.js';
import { normText, matchesQueryTokens } from './util.js';
import { budgetTracker, record, resetBudgetStats, snapshotBudgetStats } from './budget.js';

// Как часто перечитывать событие, которое ещё не в продаже (секунды).
const RECHECK_SECONDS = 3 * 60 * 60;
// Сколько результатов поиска обрабатывать на один запрос.
const MAX_RESULTS_PER_QUERY = 10;
// Ключ одноразового сброса устаревшего наличия BezKassira (см. resetStaleBezkassiraOnSale).
const META_BEZ_ON_SALE_RESET = 'bezkassiraOnSaleResetAt';
// Ключ разовой починки прошедших событий (см. resetPastEventsOnSale).
const META_PAST_EVENTS_RESET = 'pastEventsResetAt';
// Ключ разовой нормализации городов событий (см. normalizeEventCities).
const META_CITY_NORMALIZED = 'eventCityNormalizedAt';
// Ключ разовой чистки легаси-uid «афиши» (см. dedupeLegacyAfishaUids).
const META_LEGACY_UID_DEDUPE = 'legacyAfishaUidDedupedAt';
// Ключ сдвига начала обхода списка позиций (см. nextRotationOffset).
const META_ROTATION_OFFSET = 'watchRotationOffset';
// На сколько позиций сдвигаем начало обхода за цикл.
const ROTATION_STEP = 5;

// Когда (по часам процесса) последний раз обходили площадку по конкретному
// запросу: ключ = `<watch_item_id>:<venue_slug>`. Живёт в памяти процесса —
// этого достаточно, чтобы один широкий запрос не долбил площадки каждый цикл.
const venueQueryCache = new Map();

async function getMeta(key) {
  const row = await db.select().from(meta).where(eq(meta.key, key)).get();
  return row ? row.value : null;
}

async function setMeta(key, value) {
  await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

// Сдвиг начала обхода списка позиций для текущего цикла (см. runCheck).
// Растём на ROTATION_STEP позиций за цикл и берём остаток от длины списка —
// значение служит ещё и seed для перемешивания порядка (rotateItems). Значение
// хранится в meta, чтобы перезапуск процесса не «прибивал» обход к первому элементу.
async function nextRotationOffset(len) {
  if (!len) return 0;
  const prev = Number(await getMeta(META_ROTATION_OFFSET)) || 0;
  const next = (prev + ROTATION_STEP) % len;
  try {
    await setMeta(META_ROTATION_OFFSET, String(next));
  } catch (e) {
    console.warn('rotation offset save failed:', e && e.message || e);
  }
  return next;
}

// Детерминированное перемешивание по seed: одна и та же seed даёт один и тот же
// порядок (это важно — порядок должен быть воспроизводим при отладке), но от
// цикла к циклу seed меняется, поэтому «начало очереди» каждый раз другое.
// mulberry32 — короткий и достаточно равномерный PRNG для такой задачи.
function rotateItems(items, seed) {
  if (!items || items.length < 2) return items ? items.slice() : [];
  const out = items.slice();
  let state = (Math.trunc(Number(seed) || 0) + 0x9e3779b9) >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function findByUid(source, uid) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.source, source), eq(events.uid, uid)))
    .get();
}

// Событие по ссылке страницы (позиции kind='event' хранят event_url). Нужно, чтобы
// не ходить на страницу, если данные и так свежие (см. needsRecheck).
async function findEventByUrl(url) {
  if (!url) return null;
  return db.select().from(events).where(eq(events.url, url)).get();
}

// Событие уже прошло? Прошедшее событие не может быть «в продаже» и «ожидается»:
// источники (особенно площадки и кино) продолжают отдавать старые сеансы с
// isSaleOpen=true, и без этой проверки в базе копится вечно «в продаже».
// events.startsAt — unix-секунды (или Date); null — дата неизвестна, не трогаем.
// Допуск PAST_EVENT_GRACE_SEC: startsAt бывает началом дня/сеанса, а сравнение —
// по моменту проверки, поэтому спектакль, начавшийся 10 минут назад, не считаем
// «прошедшим» (иначе статистика «в продаже» просядет уже в день события).
const PAST_EVENT_GRACE_SEC = 86400;
function isPastEvent(startsAt, now = Math.floor(Date.now() / 1000)) {
  let ts = startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 && n < now - PAST_EVENT_GRACE_SEC;
}

// Приводит onSale/status к «событие прошло» (ended). Иначе возвращает поля как есть.
function settledSaleState(onSale, status, startsAt, now) {
  if (!isPastEvent(startsAt, now)) return { onSale, status };
  return { onSale: false, status: 'ended' };
}

// Разовый сброс наличия у событий BezKassira. Раньше onSale брался из JSON-LD, где
// availability = InStock даже для событий, ещё не поступивших в продажу — из-за
// этого в БД сохранились ложные onSale=true. Сбрасываем их в «неизвестно», чтобы
// цикл перечитал страницу (иначе быстрый путь «известно и в продаже» не даст
// перечитать страницу никогда). Помечаем в meta, чтобы не делать это повторно.
async function resetStaleBezkassiraOnSale() {
  if (await getMeta(META_BEZ_ON_SALE_RESET)) return;
  const stale = await db
    .select()
    .from(events)
    .where(and(eq(events.source, 'bezkassira'), eq(events.onSale, true)))
    .all();
  if (stale.length) {
    await db
      .update(events)
      .set({ onSale: false, status: 'unknown', lastCheckedAt: null })
      .where(and(eq(events.source, 'bezkassira'), eq(events.onSale, true)))
      .run();
    console.log(`[checker] bezKassira: сброшено устаревшее «в продаже» у ${stale.length} событий`);
  }
  await setMeta(META_BEZ_ON_SALE_RESET, String(Math.floor(Date.now() / 1000)));
}

// Разовая починка: у прошедших событий onSale оставался true (источники отдают
// старые сеансы как «в продаже», а чекер их больше не перечитывает). Кроме
// мусора в базе это ломало ежедневную статистику («в продаже сейчас» была
// завышена в разы). Ставим ended/onSale=false; строки НЕ удаляем — на них
// ссылаются notifications (история отправок), а dedupeKey от event_id не зависит.
// Дата неизвестна (starts_at IS NULL) — не трогаем: угадывать нельзя.
async function resetPastEventsOnSale() {
  if (await getMeta(META_PAST_EVENTS_RESET)) return;
  const now = Math.floor(Date.now() / 1000);
  // Тот же допуск, что в isPastEvent: событие считаем прошедшим только через сутки.
  const cutoff = now - PAST_EVENT_GRACE_SEC;
  const staleWhere = and(eq(events.onSale, true), sql`${events.startsAt} IS NOT NULL AND ${events.startsAt} > 0 AND ${events.startsAt} < ${cutoff}`);
  const stale = await db.select().from(events).where(staleWhere).all();
  if (stale.length) {
    await db
      .update(events)
      .set({ onSale: false, status: 'ended' })
      .where(staleWhere)
      .run();
    console.log(`[checker] прошедшие события: снято «в продаже» у ${stale.length} (status=ended)`);
  }
  await setMeta(META_PAST_EVENTS_RESET, String(now));
}

// Разовая нормализация города у уже сохранённых событий: раньше писалось то, что
// отдал источник — метка («Минск», «Брест») или слаг. Теперь upsertEvent всегда
// пишет слаг, но старые строки надо переписать: иначе сверка городов (citySlugFrom
// и сравнение со слагом позиции) и группировка данных рвутся.
async function normalizeEventCities() {
  if (await getMeta(META_CITY_NORMALIZED)) return;
  const rows = await db.select({ id: events.id, city: events.city }).from(events).all();
  let changed = 0;
  for (const row of rows) {
    const slug = citySlugFrom(row.city);
    if (!slug || slug === row.city) continue;
    await db.update(events).set({ city: slug }).where(eq(events.id, row.id)).run();
    changed++;
  }
  if (changed) console.log(`[checker] города событий нормализованы: ${changed} записей`);
  await setMeta(META_CITY_NORMALIZED, String(Math.floor(Date.now() / 1000)));
}

// Разовая чистка легаси-uid «афиши». Раньше uid был просто slug'ом, потом стал
// city-aware ('<slug>@<city>'), и старые строки остались в базе дублями нового
// события. Удалять строку нельзя напрямую: на неё могут ссылаться уведомления
// (история отправок). Поэтому сначала ПЕРЕВЕШИВАЕМ уведомления на новый eventId
// (там dedupeKey от event_id не зависит, дублей не будет), и только потом удаляем.
// Если замены с тем же slug+городом нет — строку оставляем, иначе потеряем
// единственную запись о событии.
async function dedupeLegacyAfishaUids() {
  if (await getMeta(META_LEGACY_UID_DEDUPE)) return;
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.source, 'afisha'), sql`instr(${events.uid}, '@') = 0`))
    .all();
  let removed = 0;
  for (const row of rows) {
    const city = afishaCityFromUrl(row.url) || 'minsk';
    const replacement = await findByUid('afisha', `${row.uid}@${city}`);
    if (!replacement) continue;
    await db
      .update(notifications)
      .set({ eventId: replacement.id })
      .where(eq(notifications.eventId, row.id))
      .run();
    await db.delete(events).where(eq(events.id, row.id)).run();
    removed++;
  }
  if (removed) console.log(`[checker] легаси-дубли afisha слиты: ${removed}`);
  await setMeta(META_LEGACY_UID_DEDUPE, String(Math.floor(Date.now() / 1000)));
}

function notificationKey(ev) {
  let ts = ev.startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const day = ts ? Math.floor(Number(ts) / 86400) : 'nodate';
  return `ev:${normText(ev.title)}:${day}`;
}

// Карта «ссылка события → время последней успешной проверки» для приоритета
// обхода: позиция-событие/площадка хранит event_url, а свежесть лежит в events.
// Читаем один раз за цикл, чтобы не делать запрос на каждую позицию.
async function lastCheckedByUrl() {
  const rows = await db
    .select({ url: events.url, lastCheckedAt: events.lastCheckedAt })
    .from(events)
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!r.url) continue;
    let ts = r.lastCheckedAt;
    if (ts instanceof Date) ts = ts.getTime() / 1000;
    const prev = map.get(r.url);
    if (prev === undefined || Number(ts) < prev) map.set(r.url, Number(ts));
  }
  return map;
}

// Порядок обхода позиций: самые «просроченные» — первыми.
// Раньше порядок был только случайным (rotateItems), и при исчерпанном бюджете
// это означало, что часть позиций не проверялась НИКОГДА, а не «реже». Сортировка
// по давности даёт равномерное покрытие без увеличения бюджета.
// Позиции без известных событий (новые) — в голове очереди: их надо проверить
// как можно раньше, чтобы они вообще появились в базе.
// tie-break — стабильный псевдослучайный (seed), чтобы равные по давности
// позиции не сортировались всегда одинаково.
function byStaleness(items, lastChecked, seed) {
  if (!PRIORITIZE_STALE) return rotateItems(items, seed);
  const now = Math.floor(Date.now() / 1000);
  const decorated = items.map((item) => {
    const ts = item.eventUrl ? lastChecked.get(item.eventUrl) : undefined;
    // Нет данных — проверяем в первую очередь (Infinity «давности»).
    const age = (!ts || !Number.isFinite(ts)) ? Infinity : Math.max(0, now - ts);
    return { item, age };
  });
  // Ротация внутри одинаковой давности: каждые N циклов меняется seed, и
  // порядок между «соседями по возрасту» переусредняется.
  const shuffled = rotateItems(decorated, seed);
  shuffled.sort((a, b) => b.age - a.age);
  return shuffled.map((d) => d.item);
}

// Планирование бюджета «на чат»: делим общий кошелёк между чатами, у которых
// есть активные позиции. Каждому гарантируется DETAIL_BUDGET_MIN_PER_CHAT, а
// остаток раздаётся по кругу — так один пользователь с 15 ключевиками не
// выкашивает весь бюджет цикла.
// Возвращает Map<chatId, perChatLimit>.
function planPerChatAllocation(items, total) {
  const chatIds = [...new Set(items.map((i) => i.chatId))];
  const plan = new Map();
  if (!chatIds.length) return plan;
  const min = Math.max(1, DETAIL_BUDGET_MIN_PER_CHAT);
  // Если каждому по минимуму не хватает — делим поровну (лучше по 0–1, чем
  // отдать всё первому). Бюджет без лимита на чат (без perChat) не работает.
  const base = Math.max(min, Math.floor(total / chatIds.length));
  let left = total;
  for (const id of chatIds) {
    const give = Math.min(base, left);
    plan.set(id, give);
    left -= give;
  }
  // Остаток — по кругу, по одной единице.
  let i = 0;
  while (left > 0 && chatIds.length) {
    plan.set(chatIds[i % chatIds.length], plan.get(chatIds[i % chatIds.length]) + 1);
    left -= 1;
    i += 1;
  }
  return plan;
}

async function alreadyNotified(chatId, dedupeKey) {
  const row = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.dedupeKey, dedupeKey)))
    .get();
  return !!row;
}

async function upsertEvent(ev) {
  const now = Math.floor(Date.now() / 1000);
  const existing = await findByUid(ev.source, ev.uid);
  // Город события приводим к слаг-канону ('Минск'/'минск'/'minsk' → 'minsk'):
  // разные источники отдают либо метку, либо слаг, а сверки городов — по слагам.
  const evCity = citySlugFrom(ev.city);
  if (!existing) {
    // Прошедшее событие сразу сохраняем как ended: источники отдают старые
    // сеансы с isSaleOpen=true, иначе такие строки навсегда остаются «в продаже».
    const sale = settledSaleState(ev.onSale, ev.status, ev.startsAt, now);
    const [row] = await db
      .insert(events)
      .values({
        source: ev.source,
        uid: ev.uid,
        title: ev.title,
        venue: ev.venue,
        city: evCity,
        dateText: ev.dateText,
        startsAt: ev.startsAt,
        url: ev.url,
        image: ev.image,
        priceFrom: ev.priceFrom,
        priceTo: ev.priceTo,
        currency: ev.currency,
        onSale: sale.onSale,
        status: sale.status,
        lastCheckedAt: now,
      })
      .returning();
    return { row, wasOnSale: false };
  }
  const nextStartsAt = ev.startsAt || existing.startsAt;
  const sale = settledSaleState(ev.onSale, ev.status, nextStartsAt, now);
  await db
    .update(events)
    .set({
      title: ev.title,
      venue: ev.venue || existing.venue,
      city: evCity || existing.city,
      dateText: ev.dateText || existing.dateText,
      startsAt: ev.startsAt || existing.startsAt,
      url: ev.url,
      image: ev.image || existing.image,
      priceFrom: ev.priceFrom || existing.priceFrom,
      priceTo: ev.priceTo || existing.priceTo,
      currency: ev.currency || existing.currency,
      onSale: sale.onSale,
      status: sale.status,
      updatedAt: now,
      lastCheckedAt: now,
    })
    .where(eq(events.id, existing.id))
    .run();
  return {
    row: { ...existing, ...ev, city: evCity || existing.city, onSale: sale.onSale, status: sale.status, startsAt: nextStartsAt, id: existing.id },
    wasOnSale: existing.onSale,
  };
}

async function notifyIfDue(chatId, ev, watchId) {
  if (!ev.onSale || ev.status === 'cancelled') return false;
  const dedupeKey = notificationKey(ev);
  if (await alreadyNotified(chatId, dedupeKey)) return false;
  // Ссылка на событие «афиши» может вести на «битую» страницу 24afisha.by (500) —
  // подменяем на рабочую (bycard.by), чтобы кнопка «Купить билеты» открывалась.
  let out = ev;
  if (ev.source === 'afisha' && ev.url) {
    try {
      out = { ...ev, url: await afishaWorkingEventUrl(ev.url) };
    } catch { /* оставляем исходную ссылку */ }
  }
  const caption = ticketCaption(out);
  const kb = ticketKeyboard(out, watchId);
  try {
    if (out.image) {
      await api.sendPhoto({
        chat_id: chatId,
        photo: out.image,
        caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await api.sendMessage({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  } catch (e) {
    // Картинка по внешней ссылке может не загрузиться — шлем текстом.
    console.warn('photo failed, fallback to text:', e.message);
    await api.sendMessage({
      chat_id: chatId,
      text: caption + `\n\n${out.url}`,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }
  try {
    await db.insert(notifications).values({ chatId, eventId: ev.id, dedupeKey }).run();
  } catch {
    // уникальность (chat, dedupeKey) уже соблюдена конкурентным циклом
  }
  return true;
}

// Пора ли перечитывать уже известное событие. Быстрый путь «знаем и в продаже» +
// RECHECK_SECONDS, чтобы одно и то же событие не перезаписывалось каждый цикл
// (15–30 мин) — достаточно раз в 3 часа.
//
// Отдельный случай: событие НЕ в продаже и до его начала ещё далеко больше
// RECHECK_PRESALE_HORIZON_DAYS. Тогда перечитываем раз в сутки: месяц—два до
// старта продаж ничего не меняется, а такие события стабильно выедали бюджет
// (их в базе десятки). Как только до события остаётся меньше окна,
// возвращается обычный RECHECK_SECONDS и продажа не будет пропущена.
const RECHECK_PRESALE_SECONDS = 24 * 60 * 60;
function needsRecheck(known, now) {
  if (!known || !known.lastCheckedAt) return true;
  const ts = known.lastCheckedAt instanceof Date
    ? known.lastCheckedAt.getTime() / 1000
    : known.lastCheckedAt;
  const age = now - ts;
  if (age >= RECHECK_SECONDS) {
    if (!known.onSale && isFarPresale(known, now)) {
      if (age < RECHECK_PRESALE_SECONDS) return false;
      record.presaleSkipped();
    }
    return true;
  }
  return false;
}

// Событие ещё не в продаже, а до его начала дальше горизонта предпродажи.
function isFarPresale(known, now) {
  let ts = known.startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return false;
  return n - now > RECHECK_PRESALE_HORIZON_DAYS * 86400;
}

// Ссылка на площадку «афиши» умерла (slug переименовали на сайте → 404): без
// починки позиция молча ничего не проверяет (fetchAfishaVenueEvents → venue=null).
// Ищем площадку по названию позиции. Совпадение принимаем только если оно
// однозначное: имя содержит ВСЕ токены названия, покрыто не меньше 75% слов и
// нет конкурента с таким же счётом. Иначе — не угадываем (лучше лог, чем
// подмена одной площадки другой: «Молодёжный театр» vs «Молодёжный театр эстрады»).
function venueNameScore(title, name) {
  const tokens = normText(title).split(' ').filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  if (!matchesQueryTokens(title, name)) return 0;
  const hay = normText(name);
  const covered = tokens.filter((t) => hay.includes(t)).length;
  if (covered / tokens.length < 0.75) return 0;
  // Штраф за лишние слова в названии площадки: «Мир» (1 слово) сильнее совпадает
  // с кинотеатром «Мир», чем «Джаз-клуб Евгения Владимирова».
  const words = hay.split(' ').filter((w) => w.length >= 3);
  const extra = words.filter((w) => !tokens.some((t) => w.includes(t) || t.includes(w))).length;
  return covered * 10 - extra * 3;
}

async function resolveAfishaVenueUrl(item) {
  const title = String(item.title || item.query || '').trim();
  if (!title) return null;
  try {
    const { venues } = await searchAfisha(title);
    const city = item.city || null;
    const scored = (venues || [])
      .map((v) => ({ v, score: venueNameScore(title, v.name || '') }))
      .filter((x) => x.score > 0)
      .filter((x) => {
        if (!city || city === 'all') return true;
        const vCity = venueCityFromSlug(x.v.uid || '');
        return !vCity || vCity === city;
      })
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[1].score >= scored[0].score) return null;
    const venue = await fetchAfishaVenue(scored[0].v.url);
    return afishaVenueListingUrl(venue);
  } catch (e) {
    console.warn('venue url resolve failed:', title, e && e.message || e);
    return null;
  }
}

async function checkQueryItem(item, budget, venueBudget = budget) {
  let notified = 0;
  const now = Math.floor(Date.now() / 1000);
  const sources = item.source === 'all' || !item.source ? ['afisha', 'ticketpro', 'bezkassira'] : [item.source];
  const city = item.city || null;

  for (const src of sources) {
    if (src === 'ticketpro') {
      const found = await cachedSearch('ticketpro', item.query, () => searchTicketpro(item.query));
      if (found.length > MAX_RESULTS_PER_QUERY) record.resultsTruncated();
      for (const ref of found.slice(0, MAX_RESULTS_PER_QUERY)) {
        const known = await findByUid('ticketpro', ref.uid);
        if (known && known.onSale) {
          if (await notifyIfDue(item.chatId, known, item.id)) notified++;
          continue;
        }
        if (known && known.lastCheckedAt) {
          const ts = known.lastCheckedAt instanceof Date
            ? known.lastCheckedAt.getTime() / 1000
            : known.lastCheckedAt;
          if (now - ts < RECHECK_SECONDS) continue;
        }
        if (!budget.trySpend(1, item.chatId)) continue;
        // Полные данные + реальный статус (у ticketpro JSON-LD не помечает
        // отмену/перенос) — берём со страницы события.
        const ev = await fetchTicketproEventDetails(ref.url);
        if (!ev) continue;
        // Если выбран конкретный город — фильтруем по городу площадки.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      continue;
    }
    if (src === 'bezkassira') {
      const found = await cachedSearch('bezkassira', item.query, () => searchBezkassira(item.query));
      if (found.length > MAX_RESULTS_PER_QUERY) record.resultsTruncated();
      for (const ref of found.slice(0, MAX_RESULTS_PER_QUERY)) {
        const known = await findByUid('bezkassira', ref.uid);
        if (known && known.onSale) {
          if (await notifyIfDue(item.chatId, known, item.id)) notified++;
          continue;
        }
        if (known && known.lastCheckedAt) {
          const ts = known.lastCheckedAt instanceof Date
            ? known.lastCheckedAt.getTime() / 1000
            : known.lastCheckedAt;
          if (now - ts < RECHECK_SECONDS) continue;
        }
        if (!budget.trySpend(1, item.chatId)) continue;
        const ev = await fetchBezkassiraEventDetails(ref.url);
        if (!ev) continue;
        // Если выбран конкретный город — фильтруем по городу события.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      continue;
    }
    if (src === 'afisha') {
      const { events: refs, venues } = await cachedSearch('afisha', item.query, () => searchAfisha(item.query));
      if (refs.length > MAX_RESULTS_PER_QUERY) record.resultsTruncated();
      for (const ref of refs.slice(0, MAX_RESULTS_PER_QUERY)) {
        // uid city-aware: ищем/создаём запись <slug>@<city>.
        const uid = afishaUidForCity(ref.uid, city);
        const known = await findByUid('afisha', uid);
        if (known && known.onSale) {
          if (await notifyIfDue(item.chatId, known, item.id)) notified++;
          continue;
        }
        if (known && known.lastCheckedAt) {
          const ts = known.lastCheckedAt instanceof Date
            ? known.lastCheckedAt.getTime() / 1000
            : known.lastCheckedAt;
          if (now - ts < RECHECK_SECONDS) continue;
        }
        if (!budget.trySpend(1, item.chatId)) continue;
        // Наличие по городу — через schedule API (надёжно, включая кино).
        // По умолчанию (city не задан) проверяем только город из URL результата
        // (обычно Минск), НЕ все города, чтобы не создавать поток запросов.
        const targetCity = (city && city !== 'all') ? city : afishaCityFromUrl(ref.url);
        const { onSale, event: ev } = await withCityProbe(
          (onProbe) => fetchAfishaCityAvailability(ref.url, targetCity, onProbe),
        );
        if (!onSale || !ev) continue;
        // Если выбран конкретный город — фильтруем по фактическому городу события.
        // Фолбэк по JSON-LD подменяет сегмент города в URL, а сайт может отдать
        // событие другого города (напр. могилёвский спектакль по ссылке /minsk/):
        // без этой сверки уведомление уходит на «минскую» позицию. Та же проверка,
        // что и в ветках ticketpro/bezkassira выше.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      // Площадки из того же поиска: афиша ищет и по названиям площадок, поэтому
      // запрос «РТБД», «Театр кукол», «Бельведер» отдаёт объект (площадку), а не
      // событие. Без этой ветки такие подписки никогда не срабатывали.
      notified += await notifyFromAfishaVenues(item, venues, city, venueBudget);
    }
  }
  return notified;
}

// Проверка наличия события «Афиши» по городу (schedule API, при city='all' —
// до MAX_CITY_PROBES городов). Источник сам сообщает, сколько запросов к городам
// он сделал (onProbe), иначе в статистику попал бы «1 город на позицию».
// Вторая метрика — сколько всего позиций-событий вообще запрашивалось.
async function withCityProbe(promise, onProbe = () => record.cityProbe(1)) {
  try {
    const res = await promise(onProbe);
    record.cityChecks();
    return res || { onSale: false, event: null };
  } catch (e) {
    record.cityChecks();
    throw e;
  }
}

// Площадки из результатов поиска «афиши» → уведомления по их событиям.
// Работаем как с обычной позицией-площадкой (fetchAfishaVenueEvents), но с
// ограничениями: только подходящие по имени/городу площадки, не больше
// MAX_VENUE_RESULTS_PER_QUERY штук и не дольше VENUE_CRAWL_BUDGET_MS на один
// запрос — иначе один широкий запрос («Театр») обошёл бы пол-сайта.
// Повторный обход той же площадки тем же запросом — не чаще, чем раз в
// VENUE_QUERY_RECHECK_MS. Бюджет обхода — отдельный (резерв от DETAIL_BUDGET,
// см. VENUE_BUDGET_RESERVE): кейворды не должны выедать его до начала обхода.
async function notifyFromAfishaVenues(item, venues, city, budget) {
  if (!Array.isArray(venues) || !venues.length) return 0;
  const candidates = [];
  for (const v of venues) {
    if (!v || !v.url) continue;
    // Точный город площадки знает только сама площадка; если пользователь выбрал
    // конкретный город — отбираем по городу из slug (см. venueCityFromSlug).
    if (city && city !== 'all') {
      const vCity = venueCityFromSlug(v.uid || '');
      if (vCity && vCity !== city) continue;
    }
    // Поиск афиши матчит и по другим полям, поэтому сверяем имя площадки с
    // токенами запроса. Сравнение с транслитом: «Бельведер» → «Belvedere».
    if (!matchesQueryTokens(item.query, v.name || '')) continue;
    candidates.push(v);
    if (candidates.length >= MAX_VENUE_RESULTS_PER_QUERY) break;
  }
  if (!candidates.length) return 0;
  if (candidates.length >= MAX_VENUE_RESULTS_PER_QUERY) record.venueQuotaHit();

  const crawlStartedMs = Date.now();
  const deadline = crawlStartedMs + VENUE_CRAWL_BUDGET_MS;
  let notified = 0;
  const now = Math.floor(Date.now() / 1000);
  try {
    for (const v of candidates) {
      if (Date.now() > deadline) { record.venueCrawlTruncated('time'); break; }
      if (budget.left() <= 0) { record.venueCrawlTruncated('budget'); break; }
      const key = `${item.id}:${v.uid}`;
      const last = venueQueryCache.get(key);
      if (last && Date.now() - last < VENUE_QUERY_RECHECK_MS) { record.queryVenueSkipped(); continue; }
      venueQueryCache.set(key, Date.now());
      record.queryVenueTried();
      try {
        const { events: found } = await fetchAfishaVenueEvents(v.url);
        record.venueEventsSeen(found.length);
        if (found.length > MAX_VENUE_EVENTS) record.venueEventsTruncated('quota');
        for (const ev of found.slice(0, MAX_VENUE_EVENTS)) {
          if (budget.left() <= 0) { record.venueCrawlTruncated('budget'); record.venueCrawlDeferred(); break; }
          // Прошедшие сеансы не проверяем (см. isPastEvent).
          if (isPastEvent(ev.startsAt, now)) { record.venueEventPastSkipped(); continue; }
          const known = await findByUid('afisha', ev.uid);
          if (known && known.onSale) {
            if (await notifyIfDue(item.chatId, known, item.id)) notified++;
            continue;
          }
          if (known && !needsRecheck(known, now)) continue;
          budget.spend(1, item.chatId);
          const up = await upsertEvent(ev);
          if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
        }
      } catch (e) {
        console.warn('venue (query) check failed:', v.uid, e && e.message || e);
      }
    }
  } finally {
    record.venueCrawlRun(Date.now() - crawlStartedMs);
  }
  return notified;
}

async function checkEventItem(item, budget) {
  const url = item.eventUrl;
  if (!url) return 0;
  const now = Math.floor(Date.now() / 1000);
  const isAfisha = /24afisha\.by|bycard\.by/.test(url);
  const city = item.city || null;

  if (/bezkassira\.by/i.test(url)) {
    // Свежую запись перечитывать не нужно: notifyIfDue по ней либо уже сработал,
    // либо не сработает (нет продажи) — поэтому просто выходим.
    const known = await findEventByUrl(url);
    if (known && !needsRecheck(known, now)) return 0;
    // Бюджет тратится после проверки на свежесть: повторной записи страницы нет.
    if (budget && !budget.trySpend(1, item.chatId)) return 0;
    const ev = await fetchBezkassiraEventDetails(url);
    if (!ev) return 0;
    const up = await upsertEvent(ev);
    return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
  }

  if (!isAfisha) {
    const known = await findEventByUrl(url);
    if (known && !needsRecheck(known, now)) return 0;
    if (budget && !budget.trySpend(1, item.chatId)) return 0;
    // У Ticketpro городского выбора нет: один запрос страницы = одна «проверка».
    const ev = await withCityProbe(() => fetchTicketproEventDetails(url));
    if (!ev) return 0;
    const up = await upsertEvent(ev);
    return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
  }

  // Наличие по городу берём из schedule API «афиши» (надёжно, включая кино).
  // city = null → только город из URL события (обычно Минск), НЕ все города (иначе
  // будет лишний поток запросов к 24afisha).
  // city = 'brest' → только Брест; city = 'all' → все города до первого onSale.
  const targetCity = city === 'all' ? 'all' : (city || afishaCityFromUrl(url));
  // Ссылка на страницу события могла быть «битой» (SSR 500 на 24afisha.by) —
  // чиним её в позиции (bycard.by), чтобы кнопка «Открыть» работала. Результат
  // проверки кэшируется, так что повторно страница не запрашивается.
  try {
    const fixed = await afishaWorkingEventUrl(url);
    if (fixed && fixed !== item.eventUrl) await updateWatchItemLocation(item.id, { eventUrl: fixed });
  } catch { /* не критично для проверки наличия */ }
  const { onSale, event: ev } = await withCityProbe(
    (onProbe) => fetchAfishaCityAvailability(url, targetCity, onProbe),
  );
  if (!onSale) return 0;
  if (!ev) return 0;
  const up = await upsertEvent(ev);
  return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
}

async function checkVenueItem(item, budget) {
  const url = item.eventUrl || '';
  // Площадка Ticketpro: лента событий площадки + детали (статус отмены/переноса
  // есть только на странице события).
  if (/ticketpro\.by/i.test(url)) {
    let notified = 0;
    const now = Math.floor(Date.now() / 1000);
    const links = await fetchTicketproVenueEventLinks(url);
    for (const link of links.slice(0, MAX_VENUE_EVENTS)) {
      const uid = link.url.replace(/[?#].*$/, '');
      const known = await findByUid('ticketpro', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (known && !needsRecheck(known, now)) continue;
      if (!budget.trySpend(1, item.chatId)) continue;
      const ev = await fetchTicketproEventDetails(link.url);
      if (!ev) continue;
      const up = await upsertEvent(ev);
      if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
    }
    return notified;
  }
  // Организатор BezKassira (аналог площадки): следим за событиями /organises/….
  if (/bezkassira\.by/i.test(url)) {
    let notified = 0;
    const now = Math.floor(Date.now() / 1000);
    const links = await fetchBezkassiraOrganizerEventLinks(url);
    for (const link of links.slice(0, MAX_VENUE_EVENTS)) {
      const uid = link.uid;
      const known = await findByUid('bezkassira', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (known && !needsRecheck(known, now)) continue;
      if (!budget.trySpend(1, item.chatId)) continue;
      const ev = await fetchBezkassiraEventDetails(link.url);
      if (!ev) continue;
      const up = await upsertEvent(ev);
      if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
    }
    return notified;
  }
  if (!/24afisha\.by|bycard\.by/.test(url)) {
    return checkQueryItem(item, budget);
  }
  // Площадка «афиши»: старая страница /ru/<city>/events/<slug> не работает, поэтому
  // берём мероприятия из двух API (v3-страница площадки + schedule для кино), см.
  // fetchAfishaVenueEvents. Город площадки определяется бэкендом — выбирать вручную
  // не нужно.
  let notified = 0;
  const now = Math.floor(Date.now() / 1000);
  let { venue, events: found } = await fetchAfishaVenueEvents(url);
  // Ссылка могла «умереть»: slug площадки переименовали на сайте → 404 и позиция
  // молча ничего не проверяет. Пробуем найти площадку по названию и починить URL.
  if (!venue) {
    const fixed = await resolveAfishaVenueUrl(item);
    if (fixed && fixed !== item.eventUrl) {
      const retry = await fetchAfishaVenueEvents(fixed);
      if (retry.venue) {
        await updateWatchItemLocation(item.id, { eventUrl: fixed, city: retry.venue.citySlug || undefined });
        venue = retry.venue;
        found = retry.events;
        console.log(`[checker] venue url repaired: ${item.id} -> ${fixed}`);
      }
    }
    if (!venue) {
      console.warn(`[checker] venue not resolved (dead link?): ${item.id} ${url}`);
      return notified;
    }
  }
  // Починка позиций, добавленных до правки площадок: ссылка вела на нерабочую
  // страницу площадки, город мог быть выбран вручную. Приводим к рабочим данным.
  try {
    const listing = afishaVenueListingUrl(venue);
    const newCity = venue.citySlug || null;
    const urlChanged = listing && listing !== item.eventUrl;
    if (urlChanged || newCity !== (item.city || null)) {
      await updateWatchItemLocation(item.id, {
        eventUrl: listing || undefined,
        city: newCity,
      });
    }
  } catch (e) {
    console.warn('venue meta update failed:', e && e.message || e);
  }
  // Сетка площадки отдаёт и прошедшие сеансы (у кино — весь день целиком).
  // Событие, начавшееся больше суток назад, проверять бессмысленно: пропускаем
  // ДО запросов к базе, чтобы не тратить цикл.
  // Позиция-площадка — это обычная позиция списка, а не «обход площадок из поиска»:
  // её бюджет проверяет вызывающий код до вызова (см. trySpend в runCheck), и здесь
  // нельзя ни писать в счётчики venueCrawl* (они про notifyFromAfishaVenues), ни
  // опираться на budget.left() — сюда передаётся общий бюджет, который эта ветка
  // сама не тратит.
  let processed = 0;
  record.venueEventsSeen(found.length);
  for (const ev of found) {
    if (processed >= MAX_VENUE_EVENTS) { record.venueEventsTruncated('quota'); break; }
    if (isPastEvent(ev.startsAt, now)) { record.venueEventPastSkipped(); continue; }
    const known = await findByUid('afisha', ev.uid);
    if (known && known.onSale) {
      if (await notifyIfDue(item.chatId, known, item.id)) notified++;
      continue;
    }
    if (known && !needsRecheck(known, now)) continue;
    if (budget.left() <= 0) { record.venueCrawlTruncated('budget'); record.venueCrawlDeferred(); break; }
    budget.spend(1, item.chatId);
    processed++;
    const up = await upsertEvent(ev);
    if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
  }
  return notified;
}

// Главная точка входа.
// Возвращает { skipped | checked, notified, failed }.
export async function runCheck({ force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const last = Number(await getMeta('lastCheckAt')) || 0;
    if (now - last < CHECK_INTERVAL_MIN * 60) return { skipped: true };
  }

  const startedMs = Date.now();
  // Одноразовая починка данных после исправления наличия BezKassira.
  try {
    await resetStaleBezkassiraOnSale();
  } catch (e) {
    console.warn('bezkassira on-sale reset failed:', e && e.message || e);
  }
  // Одноразовая починка: прошедшие события не могут быть «в продаже».
  try {
    await resetPastEventsOnSale();
  } catch (e) {
    console.warn('past events reset failed:', e && e.message || e);
  }
  // Одноразовая нормализация города событий к слагам.
  try {
    await normalizeEventCities();
  } catch (e) {
    console.warn('event city normalization failed:', e && e.message || e);
  }
  // Одноразовая чистка дублей с легаси-uid (slug без @city).
  try {
    await dedupeLegacyAfishaUids();
  } catch (e) {
    console.warn('legacy afisha uid dedupe failed:', e && e.message || e);
  }
  const items = await activeWatchItems();
  // Бюджеты опроса: счётчики утилизации живут в lib/budget.js (см. checkLog ниже).
  resetBudgetStats();
  resetSearchCacheStats();
  // Два «кошелька» из одного DETAIL_BUDGET: обход площадок из поиска получает
  // резерв, остальное (обычные позиции + позиции-площадки) — общий пул. Так хвост
  // списка позиций (и площадки) не голодает из-за кейвордов, которые идут раньше
  // по списку (см. VENUE_BUDGET_RESERVE в lib/config.js).
  // Внутри каждого кошелька действует лимит НА ЧАТ (см. planPerChatAllocation):
  // один пользователь с 15 ключевиками не может съесть весь бюджет цикла.
  const plainTotal = DETAIL_BUDGET - VENUE_BUDGET_RESERVE;
  const perChatPlan = planPerChatAllocation(items, plainTotal);
  const budget = budgetTracker(plainTotal);
  const venueBudget = budgetTracker(VENUE_BUDGET_RESERVE);
  let notified = 0;
  let failed = 0;

  // Порядок обхода — по давности проверки: самые «просроченные» первыми.
  // Раньше был только случайный шаффл, и при исчерпанном бюджете это значило,
  // что часть событий не проверялась никогда. Seed по-прежнему сдвигается
  // каждый цикл (для равных по давности) и живёт в meta, чтобы перезапуск
  // процесса не «прибивал» обход к первому элементу.
  const offset = await nextRotationOffset(items.length);
  const lastChecked = await lastCheckedByUrl();
  const ordered = byStaleness(items, lastChecked, offset);

  for (const item of ordered) {
    try {
      record.itemChecked();
      // Лимит чата берём из плана; если его не хватило — событие просто
      // откладывается на следующий цикл (бюджет trySpend вернёт false).
      const limit = perChatPlan.get(item.chatId);
      // Кошелёк чата нельзя дать больше, чем осталось в общем пуле.
      const scoped = limit != null
        ? budgetTracker(Math.min(limit, budget.left()), { perChat: limit })
        : budget;
      if (item.kind === 'event') notified += await checkEventItem(item, scoped);
      // Позиция-площадка тратит общий пул (резерв — только для обхода из поиска).
      else if (item.kind === 'venue') notified += await checkVenueItem(item, scoped);
      else notified += await checkQueryItem(item, scoped, venueBudget);
    } catch (e) {
      failed++;
      console.warn('check failed for item', item.id, e.message);
    }
  }

  await setMeta('lastCheckAt', String(now));

  // Логируем цикл в check_log (для ежедневной статистики). Сбой записи не роняет проверку.
  record.searchCache(snapshotSearchCacheStats());
  const usage = snapshotBudgetStats();
  try {
    await db.insert(checkLog).values({
      checked: items.length,
      notified,
      failed,
      durationMs: Date.now() - startedMs,
      detailSpent: usage.detailSpent,
      detailDenied: usage.detailDenied,
      cityProbes: usage.cityProbes,
      cityChecks: usage.cityChecks,
      cityProbesMax: usage.cityProbesMax,
      queryVenuesTried: usage.queryVenuesTried,
      queryVenuesSkipped: usage.queryVenuesSkipped,
      venueQuotaHit: usage.venueQuotaHit,
      venueCrawlTruncated: usage.venueCrawlTruncated,
      venueCrawlTimeTruncated: usage.venueCrawlTimeTruncated,
      venueCrawlBudgetTruncated: usage.venueCrawlBudgetTruncated,
      venueCrawlDeferred: usage.venueCrawlDeferred,
      venueCrawlMs: usage.venueCrawlMs,
      venueCrawlRuns: usage.venueCrawlRuns,
      venueEventsTruncated: usage.venueEventsTruncated,
      venueEventsSeen: usage.venueEventsSeen,
      venueEventsPastSkipped: usage.venueEventsPastSkipped,
      resultsTruncated: usage.resultsTruncated,
      searchCacheHits: usage.searchCacheHits,
      searchCacheMisses: usage.searchCacheMisses,
      searchCacheJoins: usage.searchCacheJoins,
      presaleSkipped: usage.presaleSkipped,
      perChatDenied: usage.perChatDenied,
    }).run();
  } catch (e) {
    console.warn('check log insert failed:', e && e.message || e);
  }

  return { checked: items.length, notified, failed };
}
