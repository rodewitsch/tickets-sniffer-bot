// Цикл проверки: поиск отслеживаемых позиций в источниках, апсерт событий,
// уведомления о появлении билетов.
import db from '../db.js';
import { api } from '../api.js';
import { events, notifications, checkLog, meta } from '../schema.js';
import { eq, and, sql } from '../db.js';
import { CHECK_INTERVAL_MIN, DETAIL_BUDGET, VENUE_BUDGET_RESERVE, MAX_VENUE_EVENTS, VENUE_CRAWL_BUDGET_MS, DETAIL_BUDGET_MIN_PER_CHAT, RECHECK_PRESALE_HORIZON_DAYS, URGENCY_WINDOW_DAYS, URGENCY_BONUS_MAX, VENUE_QUEUE_PER_CYCLE, VENUE_QUEUE_HOT_DAYS, VENUE_QUEUE_HOT_SECONDS, VENUE_QUEUE_SOON_SECONDS, VENUE_QUEUE_PRESALE_SECONDS, VENUE_QUERY_RECHECK_MS } from './config.js';
import { activeWatchItems, updateWatchItemLocation, markWatchItemChecked, bumpWatchItemDefer } from './watch.js';
import { cachedSearch, resetSearchCacheStats, snapshotSearchCacheStats } from './search-cache.js';
import { enqueueVenue, dueVenues, dueVenueCount, rescheduleVenue, failVenue, dropVenue, pruneVenueQueue } from './venue-queue.js';
import { searchAfisha, fetchAfishaCityAvailability, fetchAfishaVenue, fetchAfishaVenueEvents, afishaVenueListingUrl, afishaWorkingEventUrl } from './sources/afisha.js';
import { searchTicketpro, fetchTicketproEventDetails, fetchTicketproVenueEventLinks } from './sources/ticketpro.js';
import { searchBezkassira, fetchBezkassiraEventDetails, fetchBezkassiraOrganizerEventLinks } from './sources/bezkassira.js';
import { afishaUidForCity, afishaCityFromUrl } from './normalize.js';
import { cityLabel, venueCityFromSlug, citySlugFrom } from './cities.js';
import { ticketCaption, ticketKeyboard } from './menus.js';
import { normText, matchesQueryTokens } from './util.js';
import { budgetTracker, record, resetBudgetStats, snapshotBudgetStats } from './budget.js';
import { cycleStart, cycleSummary, itemDone, itemFailed, skip as logSkip, logEnabled } from './checker-log.js';

// Как часто перечитывать уже известное событие, когда билеты УЖЕ в продаже
// или их только ждут (секунды). Три уровня — по близости старта:
//   горячее (<= RECHECK_HOT_DAYS)      → RECHECK_HOT_SECONDS
//   ближнее (<= RECHECK_PRESALE_HORIZON_DAYS) → RECHECK_SECONDS
//   дальнее                             → RECHECK_PRESALE_SECONDS
// См. recheckInterval() ниже.
const RECHECK_HOT_DAYS = 7;
const RECHECK_HOT_SECONDS = 60 * 60;
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

// Через сколько можно обходить площадку из очереди — по срочности её ближайшей
// постановки. Площадка, у которой есть событие «на этой неделе», опрашивается
// каждый час: билеты на такие даты появляются и уходят быстро. Далёкая площадка
// (все события через месяц) не изменится за сутки — её и проверяем раз в сутки.
//
// Раньше всех площадок касался один VENUE_QUERY_RECHECK_MS = 3 ч, и в проде это
// давало 1296 «пропущено по троттлингу» на 85 реальных обходов.
function venueIntervalMs(startTimes, now) {
  let soonest = Infinity;
  for (const ts of startTimes || []) {
    let n = ts instanceof Date ? ts.getTime() / 1000 : Number(ts);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n < soonest) soonest = n;
  }
  if (!Number.isFinite(soonest)) return VENUE_QUEUE_PRESALE_SECONDS * 1000;
  const daysLeft = (soonest - now) / 86400;
  const sec = daysLeft <= VENUE_QUEUE_HOT_DAYS
    ? VENUE_QUEUE_HOT_SECONDS
    : daysLeft <= RECHECK_PRESALE_HORIZON_DAYS
      ? VENUE_QUEUE_SOON_SECONDS
      : VENUE_QUEUE_PRESALE_SECONDS;
  // Нижняя граница — VENUE_QUERY_RECHECK_MS: даже «горячую» площадку не дёргаем
  // чаще, чем позволяет вежливость к сайту.
  return Math.max(sec * 1000, VENUE_QUERY_RECHECK_MS);
}

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

// Периодическая починка «воскресших» прошедших событий.
//
// resetPastEventsOnSale выше отрабатывает ОДИН раз (флаг в meta). Но прошедшие
// события продолжают появляться в базе и позже: площадка отдаёт старые сеансы,
// поиск возвращает уже отыгранное событие с isSaleOpen=true, и upsertEvent
// сохраняет его как «в продаже». В проде набралось 11 таких строк, и они
// завышали статистику «в продаже сейчас» и занимали место в обходе.
//
// Поэтому теперь это НЕ разовая акция, а дешёвая периодическая уборка: один
// UPDATE по индексу раз в сутки (никаких сетевых запросов). Строки НЕ удаляем —
// на них ссылаются notifications (история отправок).
const META_PAST_EVENTS_SWEEP = 'pastEventsSweepAt';
const PAST_EVENTS_SWEEP_INTERVAL_SEC = 24 * 60 * 60;

async function sweepPastEventsOnSale() {
  const last = Number(await getMeta(META_PAST_EVENTS_SWEEP)) || 0;
  const now = Math.floor(Date.now() / 1000);
  if (last && now - last < PAST_EVENTS_SWEEP_INTERVAL_SEC) return 0;
  const cutoff = now - PAST_EVENT_GRACE_SEC;
  const staleWhere = and(
    eq(events.onSale, true),
    sql`${events.startsAt} IS NOT NULL AND ${events.startsAt} > 0 AND ${events.startsAt} < ${cutoff}`,
  );
  const stale = await db.select({ id: events.id }).from(events).where(staleWhere).all();
  if (stale.length) {
    await db.update(events).set({ onSale: false, status: 'ended' }).where(staleWhere).run();
    console.log(`[checker] прошедшие события: снято «в продаже» у ${stale.length}`);
  }
  await setMeta(META_PAST_EVENTS_SWEEP, String(now));
  return stale.length;
}

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
    .select({ url: events.url, lastCheckedAt: events.lastCheckedAt, startsAt: events.startsAt })
    .from(events)
    .all();
  const map = new Map();
  const starts = new Map();
  for (const r of rows) {
    if (!r.url) continue;
    let ts = r.lastCheckedAt;
    if (ts instanceof Date) ts = ts.getTime() / 1000;
    const prev = map.get(r.url);
    if (prev === undefined || Number(ts) < prev) map.set(r.url, Number(ts));
    // Дата старта нужна для «срочности» (см. urgencyBonus в byDebt).
    if (r.startsAt) starts.set(r.url, r.startsAt);
  }
  return { lastChecked: map, starts };
}

// Порядок обхода позиций — по «долгу» и «срочности»: сначала те, кого
// откладывали дольше всех; при равном долге — те, чьё событие ближе к старту.
//
// Раньше порядок был случайным шаффлом, и при исчерпанном бюджете это значило,
// что часть позиций не проверяется НИКОГДА. Сортировка по давности данных
// (last_checked_at события) помогала не полностью: у чата с одной позицией
// «молодое» событие всегда проигрывало свежему событию крупного чата.
//
// Приоритет считаем по четырём уровням (больше — раньше в очереди):
//   1. deferStreak > 0 — позицию откладывали N циклов подряд (прямой долг);
//   2. «возраст» проверки самой позиции (watch_items.last_checked_at);
//      новые позиции (никогда не проверялись) — в голове очереди;
//   3. срочность: чем ближе старт события, тем выше (см. URGENCY_* в config);
//   4. давность данных события и стабильный seed-шаффл.
//
// Срочность нужна именно боту, а не «равной очереди»: билеты появляются за
// дни до выступления, и событие «завтра» важнее события «через два месяца»,
// даже если оба формально просрочены одинаково. При этом срочность НЕ бьёт долг:
// позиция, отложенная в прошлом цикле, всё равно пойдёт раньше.
function urgencyBonus(startsAt, now) {
  let ts = startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const daysLeft = (n - now) / 86400;
  if (daysLeft < 0) return URGENCY_BONUS_MAX; // уже идёт/сегодня — максимум
  if (daysLeft >= URGENCY_WINDOW_DAYS) return 0;
  return Math.ceil(URGENCY_BONUS_MAX * (1 - daysLeft / URGENCY_WINDOW_DAYS));
}

function byDebt(items, lastChecked, seed, startsByUrl) {
  const now = Math.floor(Date.now() / 1000);
  const decorated = items.map((item) => {
    const ts = item.eventUrl ? lastChecked.get(item.eventUrl) : undefined;
    const eventAge = (!ts || !Number.isFinite(ts)) ? Infinity : Math.max(0, now - ts);
    // Возраст проверки самой позиции: NULL → никогда (максимальный долг).
    const ownTs = item.lastCheckedAt instanceof Date
      ? item.lastCheckedAt.getTime() / 1000
      : Number(item.lastCheckedAt);
    const ownAge = (!Number.isFinite(ownTs) || ownTs <= 0) ? Infinity : Math.max(0, now - ownTs);
    const startsAt = item.eventUrl ? startsByUrl?.get(item.eventUrl) : undefined;
    return {
      item,
      streak: Number(item.deferStreak) || 0,
      ownAge,
      eventAge,
      urgency: urgencyBonus(startsAt, now),
    };
  });
  const shuffled = rotateItems(decorated, seed);
  shuffled.sort((a, b) => {
    // 1. Долг по откладываниям.
    if (a.streak !== b.streak) return b.streak - a.streak;
    // 2. Давность проверки самой позиции (Infinity — новые, они первые).
    if (a.ownAge !== b.ownAge) {
      if (a.ownAge === Infinity) return -1;
      if (b.ownAge === Infinity) return 1;
      return b.ownAge - a.ownAge;
    }
    // 3. Срочность: ближайшее по дате событие — раньше.
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    // 4. Давность данных события.
    if (a.eventAge !== b.eventAge) {
      if (a.eventAge === Infinity) return -1;
      if (b.eventAge === Infinity) return 1;
      return b.eventAge - a.eventAge;
    }
    return 0;
  });
  return shuffled.map((d) => d.item);
}

// Планирование бюджета «на чат»: страховка от одного «жадного» пользователя,
// а НЕ основной механизм справедливости (он — в порядке обхода, см. byDebt).
//
// Правило: каждому чату с активными позициями гарантируется
// DETAIL_BUDGET_MIN_PER_CHAT, остаток делится пропорционально числу позиций.
// Порядок двухпроходный, чтобы инвариант «сумма квот ≤ бюджет» держался всегда:
//   1) floor по минимуму каждому (жадно, в порядке убывания числа позиций);
//   2) остаток — пропорционально позициям, дробные части приоритетнее.
//
// Почему так, а не «поровну» и не «чистая пропорция»:
//   • поровну при 16 единицах на 10 чатов даёт 1 единицу всем, но 6-позиционному
//     чату этого хватает только на 1 позицию из 6 — остальные пять голодают;
//   • чистая пропорция даёт семи чатам с одной позицией по 0 (floor от 0.76) —
//     они не проверяются НИКОГДА, что и случилось в проде.
// Комбинация «минимум всем + пропорция на остаток» не даёт ни нулевых квот, ни
// полного застоя маленьких чатов.
//
// Возвращает Map<chatId, perChatLimit>.
function planPerChatAllocation(items, total) {
  const counts = new Map();
  for (const i of items) counts.set(i.chatId, (counts.get(i.chatId) || 0) + 1);
  const plan = new Map();
  if (!counts.size) return plan;
  if (total <= 0) {
    for (const id of counts.keys()) plan.set(id, 0);
    return plan;
  }

  const min = Math.max(1, DETAIL_BUDGET_MIN_PER_CHAT);
  // Больше позиций — раньше в очереди на гарантированный минимум.
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [id] of ordered) plan.set(id, 0);

  // 1) Гарантированный минимум.
  let left = total;
  for (const [id] of ordered) {
    if (left <= 0) break;
    const give = Math.min(min, left);
    plan.set(id, give);
    left -= give;
  }

  // 2) Остаток — пропорционально числу позиций. Используем метод наибольших
  // остатков: раздаём floor, затем остаток достаётся чатам с самой большой
  // дробной частью (при равенстве — тому, у кого больше позиций).
  if (left > 0) {
    const N = items.length;
    const shares = ordered.map(([id, n]) => {
      const exact = (left * n) / N;
      return { id, n, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    let rest = left;
    for (const s of shares) {
      if (rest <= 0) break;
      const give = Math.min(s.whole, rest);
      plan.set(s.id, plan.get(s.id) + give);
      rest -= give;
    }
    shares.sort((a, b) => b.frac - a.frac || b.n - a.n || a.id - b.id);
    let i = 0;
    while (rest > 0 && shares.length) {
      plan.set(shares[i % shares.length].id, plan.get(shares[i % shares.length].id) + 1);
      rest -= 1;
      i += 1;
    }
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

// Пора ли перечитывать уже известное событие. Интервал ЗАВИСИТ ОТ СРОЧНОСТИ:
// задача бота — поймать старт продаж раньше пользователя, поэтому горячие
// события (старт скоро) опрашиваются часто, а далёкие — редко.
//
//   старт <= 7 дней   → RECHECK_HOT_SECONDS   (1 час — билеты появляются/исчезают быстро)
//   старт 8–14 дней   → RECHECK_SECONDS       (3 часа)
//   старт дальше      → RECHECK_PRESALE_SECONDS (сутки), и только если не в продаже
//
// Уже в продаже событие тоже надо перечитывать: билеты могут закончиться и
// снова появиться (возвраты), а перенос/отмена меняют статус. Поэтому для
// горячих интервал одинаков независимо от onSale.
//
// Событие с неизвестной датой — обычный RECHECK_SECONDS (данных мало, угадывать
// нельзя).
const RECHECK_PRESALE_SECONDS = 24 * 60 * 60;
function recheckInterval(known, now) {
  let ts = known.startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) {
    // Дата неизвестна: если не в продаже — тоже сутки (проверяли выше), иначе обычный.
    return known.onSale ? RECHECK_SECONDS : RECHECK_PRESALE_SECONDS;
  }
  const daysLeft = (n - now) / 86400;
  if (daysLeft <= RECHECK_HOT_DAYS) return RECHECK_HOT_SECONDS;
  if (daysLeft <= RECHECK_PRESALE_HORIZON_DAYS) return RECHECK_SECONDS;
  // Дальше горизонта: в продаже — перечитываем реже, но всё равно раз в сутки
  // (возвраты билетов возможны даже за месяц до события).
  return RECHECK_PRESALE_SECONDS;
}

function needsRecheck(known, now) {
  if (!known || !known.lastCheckedAt) return true;
  const ts = known.lastCheckedAt instanceof Date
    ? known.lastCheckedAt.getTime() / 1000
    : known.lastCheckedAt;
  const age = now - ts;
  const interval = recheckInterval(known, now);
  if (age >= interval) {
    // Дальние не-в-продаже события пропускаем осознанно — счётчик для отчёта.
    if (interval === RECHECK_PRESALE_SECONDS && !known.onSale) record.presaleSkipped();
    return true;
  }
  return false;
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

// Проверка позиции-ключевика: поиск по источникам + детали найденных событий.
async function checkQueryItem(item, budget) {
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
      // Обхода здесь нет: только постановка в venue_queue, обход — runVenueCrawl.
      await notifyFromAfishaVenues(item, venues, city);
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
//
// Раньше здесь же был и обход: фильтр → slice(0, MAX_VENUE_RESULTS_PER_QUERY) →
// сразу fetchAfishaVenueEvents с троттлингом в Set по времени запуска процесса.
// Прод показал, что от этого толку мало: за сутки 85 обходов против 1296
// отказов троттлинга, а `venueQuotaHit` рос 3 раза за КАЖДЫЙ цикл (всегда одни и
// те же площадки из головы выдачи, хвост — никогда).
//
// Теперь функция только РЕГИСТРИРУЕТ кандидатов в очереди (venue_queue), а сами
// обходы делает runVenueCrawl() в начале цикла, с бюджетом на весь цикл. Площадка,
// которую не успели или которую отложила срочность, не теряется — у неё есть dueAt.
// Ротация выдачи больше не нужна: ротацию делает планировщик (по dueAt).
async function notifyFromAfishaVenues(item, venues, city) {
  if (!Array.isArray(venues) || !venues.length) return 0;
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  // Разные позиции-ключевики («театр» и «Театр») находят ОДНИ И ТЕ ЖЕ площадки.
  // Без этой защиты каждая такая позиция заводила свою запись очереди, и один и
  // тот же сайт обходился два-три раза за цикл (в проде: 13 записей на 9
  // уникальных площадок). Ключ — URL площадки, а не позиция. Запись при этом
  // «достаётся» всем подходящим позициям: при обходе уведомления улетают всем
  // чатам, чей поиск её нашёл (см. recipients в runVenueCrawl).
  const seen = new Set();
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
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    // Новая площадка обходится в ЭТОМ цикле (dueAt = сейчас), потому что цикл
    // читает очередь уже после обхода позиций (см. порядок в runCheck).
    if (await enqueueVenue({ watchItemId: item.id, chatId: item.chatId, venue: v, dueAt: now })) added += 1;
  }
  if (added) record.queryVenueEnqueued(added);
  return 0;
}

// Обход площадок из очереди — в начале цикла, с общим лимитом на цикл.
//
// Берём до VENUE_QUEUE_PER_CYCLE записей с наступившим dueAt, обходим их
// детерминированно (fetchAfishaVenueEvents), уведомления шлём ПОСЛЕ обхода — иначе
// отправка внутри цикла съедала бы бюджет обхода (именно так терялись площадки).
// Сдвиг dueAt делается ДО обхода: если обход упадёт, запись не останется
// «просроченной навсегда».
async function runVenueCrawl({ budget, walletOf }) {
  const now = Math.floor(Date.now() / 1000);
  // Ждёт ли что-то обхода вообще — нужно для honest-статистики «сколько в очереди».
  const waiting = await dueVenueCount(now);
  if (waiting) record.venueQueueWaiting(waiting);
  const rows = await dueVenues(VENUE_QUEUE_PER_CYCLE, now);
  if (!rows.length) return 0;

  const crawlStartedMs = Date.now();
  const deadline = crawlStartedMs + VENUE_CRAWL_BUDGET_MS;
  // Уведомления копим здесь, а не шлём на месте: отправка — сетевой вызов
  // Telegram, он не должен отнимать время у обхода площадок.
  const pending = [];
  // Один и тот же URL площадки может стоять в очереди от нескольких позиций
  // («театр» и «Театр» ищут одно и то же). Страницу обходим ОДИН раз, а
  // уведомления рассылаем всем заинтересованным чатам.
  const byUrl = new Map();
  let crawled = 0;
  let deferred = 0;

  for (const row of rows) {
    if (Date.now() > deadline) { record.venueCrawlTruncated('time'); break; }
    if (budget.left() <= 0) { record.venueCrawlTruncated('budget'); break; }

    const group = byUrl.get(row.url);
    if (group) {
      // Эта площадка уже обойдена в текущем проходе: не ходим на сайт второй раз,
      // только переносим срок и получателя.
      group.push(row);
      continue;
    }
    byUrl.set(row.url, [row]);

    let venue = null;
    let found = [];
    try {
      ({ venue, events: found } = await fetchAfishaVenueEvents(row.url));
    } catch (e) {
      console.warn('venue queue crawl failed:', row.slug, e && e.message || e);
    }
    if (!venue) {
      // Площадка не открылась (slug переименовали) — backoff, а не долбёж каждый
      // цикл. Через час снова попробуем: страницы «афиши» бывают временно
      // недоступны, удалять запись из-за одного сбоя нельзя.
      await failVenue(row.id, { dueAt: now + VENUE_QUERY_RECHECK_MS, attempts: 1 });
      record.venueQueueFailed();
      continue;
    }

    record.queryVenueTried();
    crawled += 1;
    record.venueEventsSeen(found.length);

    // Свежие идут первыми — тогда при исчерпании бюджета обрабатываем то, что
    // скоро начнётся, а не сетку с прошлого месяца.
    const fresh = found.filter((ev) => !isPastEvent(ev.startsAt, now));
    record.venueEventPastSkipped(found.length - fresh.length);
    fresh.sort((a, b) => (Number(a.startsAt) || Infinity) - (Number(b.startsAt) || Infinity));

    // Продолжаем с курсора, если он задан и ещё влезает в сетку; иначе сначала.
    const start = row.cursor > 0 && row.cursor < fresh.length ? row.cursor : 0;
    const slice = fresh.slice(start, start + MAX_VENUE_EVENTS);
    if (start + MAX_VENUE_EVENTS < fresh.length) record.venueEventsTruncated();
    const nextCursor = start + slice.length >= fresh.length ? 0 : start + slice.length;

    const nextDue = now + Math.round(venueIntervalMs(fresh.map((ev) => ev.startsAt), now) / 1000);
    // Планируем следующий обход ДО самой работы: падение внутри не оставит запись
    // в состоянии «просрочена, обходим каждый цикл». Остальные записи этой же
    // площадки (другие позиции) получают тот же срок — сайт уже обойдён.
    for (const r of byUrl.get(row.url)) {
      await rescheduleVenue(r.id, { dueAt: nextDue, cursor: nextCursor, failing: false });
    }

    for (const ev of slice) {
      if (budget.left() <= 0) { record.venueCrawlTruncated('budget'); deferred += 1; break; }
      const known = await findByUid('afisha', ev.uid);
      // Получатели — все позиции, чей поиск нашёл эту площадку.
      const targets = byUrl.get(row.url);
      if (known && known.onSale) {
        for (const r of targets) pending.push({ row: r, ev: known });
        continue;
      }
      if (known && !needsRecheck(known, now)) { record.skippedFresh(); continue; }
      // Бюджет тратим один раз на событие (страницу читаем одну), но квоту «на
      // чат» проверяем для каждого получателя — иначе один пользователь с
      // двумя ключевиками обходил бы лимит вдвое.
      const payer = targets.find((r) => walletOf(r.chatId).left() >= 1);
      if (!payer) { deferred += 1; break; }
      if (!walletOf(payer.chatId).trySpend(1)) { deferred += 1; break; }
      budget.spend(1);
      const up = await upsertEvent(ev);
      for (const r of targets) pending.push({ row: r, ev: up.row });
    }
    if (deferred) record.venueCrawlDeferred();
  }

  if (crawled) record.venueQueueCrawled(crawled);
  record.venueCrawlRun(Date.now() - crawlStartedMs);
  record.queryVenueSkipped(Math.max(0, waiting - rows.length));

  // Отправка уведомлений — после обхода, чтобы не тратить его бюджет.
  let notified = 0;
  for (const { row, ev } of pending) {
    try {
      if (await notifyIfDue(row.chatId, ev, row.watchItemId)) notified += 1;
    } catch (e) {
      console.warn('venue queue notify failed:', row.slug, e && e.message || e);
    }
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
    if (known && !needsRecheck(known, now)) {
      record.skippedFresh();
      logSkip({ id: item.id, reason: 'fresh' });
      return 0;
    }
    // Бюджет тратится после проверки на свежесть: повторной записи страницы нет.
    if (budget && !budget.trySpend(1, item.chatId)) {
      record.noBudget();
      logSkip({ id: item.id, reason: 'no-budget' });
      return 0;
    }
    const ev = await fetchBezkassiraEventDetails(url);
    if (!ev) {
      record.emptyResult();
      return 0;
    }
    const up = await upsertEvent(ev);
    if (!(await notifyIfDue(item.chatId, up.row, item.id))) {
      record.notOnSale();
      return 0;
    }
    return 1;
  }

  if (!isAfisha) {
    const known = await findEventByUrl(url);
    if (known && !needsRecheck(known, now)) {
      record.skippedFresh();
      logSkip({ id: item.id, reason: 'fresh' });
      return 0;
    }
    if (budget && !budget.trySpend(1, item.chatId)) {
      record.noBudget();
      logSkip({ id: item.id, reason: 'no-budget' });
      return 0;
    }
    // У Ticketpro городского выбора нет: один запрос страницы = одна «проверка».
    const ev = await withCityProbe(() => fetchTicketproEventDetails(url));
    if (!ev) {
      record.emptyResult();
      return 0;
    }
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
  if (!onSale) {
    record.notOnSale();
    logSkip({ id: item.id, reason: 'no-sale', detail: { city: targetCity } });
    return 0;
  }
  if (!ev) {
    record.emptyResult();
    logSkip({ id: item.id, reason: 'no-event' });
    return 0;
  }
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
  // Периодическая (раз в сутки) уборка «воскресших» прошедших событий: см.
  // sweepPastEventsOnSale. Без сетевых запросов, один UPDATE.
  try {
    await sweepPastEventsOnSale();
  } catch (e) {
    console.warn('past events sweep failed:', e && e.message || e);
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
  // Кошелёк обхода площадок из очереди (резерв из DETAIL_BUDGET).
  // Тратится ТОЛЬКО в runVenueCrawl — позиции его не видят, поэтому и не могут
  // выесть: ключевики получают plainTotal, резерв ждёт свой обход.
  const venueBudget = budgetTracker(VENUE_BUDGET_RESERVE);
  // Фактический расход по чатам за цикл. Квота — свойство ЦИКЛА, поэтому
  // кошельки ведутся здесь, а не пересоздаются на каждой позиции: иначе квота
  // обнулялась бы у каждой позиции и «лимит на чат» не ограничивал бы ничего
  // (именно так и было: per_chat_denied=18 при квотах 1..3).
  const chatWallets = new Map();
  const walletFor = (chatId) => {
    let w = chatWallets.get(chatId);
    if (!w) {
      const quota = perChatPlan.get(chatId) ?? Infinity;
      w = budgetTracker(quota, { perChat: quota });
      chatWallets.set(chatId, w);
    }
    return w;
  };
  let notified = 0;
  let failed = 0;

  cycleStart({ items, perChatPlan, plainTotal, venueTotal: VENUE_BUDGET_RESERVE });

  // Порядок обхода — по «долгу» позиции (см. byDebt): отложенные дольше всех
  // идут первыми. Seed по-прежнему сдвигается каждый цикл (для равных по долгу)
  // и живёт в meta, чтобы перезапуск процесса не «прибивал» обход к первому.
  const offset = await nextRotationOffset(items.length);
  const { lastChecked, starts } = await lastCheckedByUrl();
  const ordered = byDebt(items, lastChecked, offset, starts);

  for (const item of ordered) {
    const itemStartedMs = Date.now();
    try {
      record.itemChecked();
      // Кошелёк чата живёт весь цикл: квота тратится общая, а не на позицию.
      // Общий пул тоже конечен — траты идут в оба кошелька.
      const limit = perChatPlan.get(item.chatId) ?? Infinity;
      const wallet = walletFor(item.chatId);
      // Позиция отложена, если истратить уже нечего — общий пул или квота чата.
      const starved = limit <= 0 || wallet.left() <= 0 || budget.left() <= 0;
      const scoped = starved ? null : {
        // Тратим из двух кошельков одновременно: сначала проверяем оба, потом
        // списываем. Обёртка сохраняет старый интерфейс (left/trySpend/spend),
        // которым пользуются все ветки проверки.
        left: () => Math.min(wallet.left(), budget.left()),
        trySpend: (n = 1) => {
          if (wallet.left() < n || budget.left() < n) return false;
          wallet.spend(n);
          budget.spend(n);
          return true;
        },
        spend: (n = 1) => {
          wallet.spend(n);
          budget.spend(n);
        },
      };
      let got = 0;
      if (!starved) {
        if (item.kind === 'event') got = await checkEventItem(item, scoped);
        // Позиция-площадка тратит общий пул (резерв — только для обхода из поиска).
        else if (item.kind === 'venue') got = await checkVenueItem(item, scoped);
        else got = await checkQueryItem(item, scoped);
      }
      notified += got;

      // Долг позиции: отложенным он растёт (приоритет на следующие циклы),
      // проверенным сбрасывается. Так «голодная» позиция обгонит соседей, даже
      // если у её чата мало квоты, — независимо от размера чата.
      if (starved) {
        await bumpWatchItemDefer(item.id);
        record.noBudget();
        logSkip({ id: item.id, reason: 'no-budget', detail: { chatQuota: limit } });
      } else {
        await markWatchItemChecked(item.id);
      }

      itemDone({
        id: item.id,
        kind: item.kind,
        chatId: item.chatId,
        outcome: starved ? 'deferred' : (got > 0 ? 'notified' : 'check'),
        ms: Date.now() - itemStartedMs,
        notified: got,
        detail: item.kind === 'query' ? item.query : (item.eventUrl || item.title || undefined),
      });
    } catch (e) {
      failed++;
      record.errorItem();
      itemFailed({ id: item.id, kind: item.kind, chatId: item.chatId, err: e, ms: Date.now() - itemStartedMs });
      console.warn('check failed for item', item.id, e.message);
    }
  }

  // ОБХОД ПЛОЩАДОК ИЗ ОЧЕРЕДИ — после позиций.
  //
  // Почему после, а не до: позиции-ключевики тем же поиском только что поставили
  // в очередь свежих кандидатов (dueAt = сейчас), и обход в начале цикла брал бы
  // вчерашний список, а новых площадок ждал бы до следующего раза. Бюджет обхода
  // отдельный (venueBudget) и позиции его не трогают, поэтому очередь не
  // голодает от того, что идёт второй.
  try {
    // Убираем записи площадок удалённых/выключенных позиций (FK в SQLite нет).
    await pruneVenueQueue(items.map((i) => i.id));
    // Кошелёк чата уже мог быть израсходован позициями — обход тратит из
    // отдельного venueBudget, а walletFor нужен только для лимита на чат.
    notified += await runVenueCrawl({ budget: venueBudget, walletOf: walletFor });
  } catch (e) {
    console.warn('venue queue crawl failed:', e && e.message || e);
  }

  await setMeta('lastCheckAt', String(now));

  // Логируем цикл в check_log (для ежедневной статистики). Сбой записи не роняет проверку.
  record.searchCache(snapshotSearchCacheStats());
  const usage = snapshotBudgetStats();
  const cache = snapshotSearchCacheStats();
  cycleSummary({
    durationMs: Date.now() - startedMs,
    checked: items.length,
    notified,
    failed,
    usage,
    cache,
    ordered,
    perChatPlan,
  });
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
      venueQueued: usage.venueQueued,
      venueQueueWaiting: usage.venueQueueWaiting,
      venueQueueCrawled: usage.venueQueueCrawled,
      venueQueueFailed: usage.venueQueueFailed,
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
      skippedFresh: usage.skippedFresh,
      noBudget: usage.noBudget,
      emptyResult: usage.emptyResult,
      notOnSale: usage.notOnSale,
      errorItems: usage.errorItems,
    }).run();
  } catch (e) {
    console.warn('check log insert failed:', e && e.message || e);
  }

  return { checked: items.length, notified, failed };
}
