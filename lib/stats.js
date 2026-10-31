// Сбор и отправка ежедневной статистики владельцу бота (чат STATS_CHAT_ID).
// Считаем пользователей, отслеживание, события, уведомления и циклы проверки.
import db from '../db.js';
import { api } from '../api.js';
import { users, watchItems, events, notifications, checkLog, meta, venueQueue } from '../schema.js';
import { eq } from '../db.js';
import { STATS_CHAT_ID, STATS_SEND_HOUR, STATS_SEND_MINUTE, DETAIL_BUDGET, VENUE_BUDGET_RESERVE, MAX_CITY_PROBES, VENUE_QUEUE_PER_CYCLE, MAX_VENUE_EVENTS, VENUE_CRAWL_BUDGET_MS, AI_TREND_DAYS, PAST_EVENT_GRACE_SEC } from './config.js';
import { aiReportEnabled, requestAiReport } from './ai-report.js';
import { escapeHtml } from './util.js';

export const TZ = 'Europe/Minsk';

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Текущие компоненты локального времени в Минске: { year, month, day, hour, minute, second }.
export function minskParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23',
  });
  const out = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

// Начало текущих суток по Минску в unix-секундах.
export function todayStartSec(now = Date.now()) {
  const p = minskParts(new Date(now));
  return Math.floor(now / 1000) - (p.hour * 3600 + p.minute * 60 + p.second);
}

/**
 * Конец окна ежедневного отчёта: ближайшее прошедшее (или текущее) время отправки
 * STATS_SEND_HOUR:STATS_SEND_MINUTE по Минску, unix-секунды.
 *
 * Зачем: отчёт уходит в 09:00, значит и «сутки» для него — с 09:00 вчера до 09:00
 * сегодня, а НЕ с полуночи. Иначе отчёт покрывал бы только 0:00–9:00 (девять часов),
 * а при catch-up-отправке после перезапуска окно ещё и зависело бы от момента старта.
 */
export function reportPeriodEndSec(now = Date.now()) {
  const p = minskParts(new Date(now));
  const nowSec = Math.floor(now / 1000);
  const sinceMidnight = p.hour * 3600 + p.minute * 60 + p.second;
  const midnight = nowSec - sinceMidnight;
  const target = STATS_SEND_HOUR * 3600 + STATS_SEND_MINUTE * 60;
  // Если время отправки ещё не наступило — окно закрылось вчера в это же время.
  return sinceMidnight >= target ? midnight + target : midnight + target - 86400;
}


// Миллисекунды до ближайшего времени hour:minute по Минску (если уже прошло — до завтра).
export function msUntilNextMinsk(hour, minute, now = Date.now()) {
  const p = minskParts(new Date(now));
  const nowMin = p.hour * 60 + p.minute;
  const targetMin = hour * 60 + minute;
  let diffMin = targetMin - nowMin;
  if (diffMin <= 0) diffMin += 24 * 60;
  return (diffMin * 60 - p.second) * 1000;
}

function minskDateKey(now = Date.now()) {
  const p = minskParts(new Date(now));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function minskDateLabel(now = Date.now()) {
  const p = minskParts(new Date(now));
  return `${p.day} ${MONTHS_GEN[p.month - 1]} ${p.year}`;
}

function formatTimeMinsk(sec) {
  const p = minskParts(new Date(sec * 1000));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// «21.10 09:00» — для шапки с границами окна отчёта.
function formatShortDate(sec) {
  const p = minskParts(new Date(sec * 1000));
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  return `${dd}.${mm} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function countBy(rows, key) {
  const map = {};
  for (const r of rows) {
    const k = r[key] || '—';
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

function sumBy(rows, key) {
  return rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
}

function tsNum(v) {
  return Number(v) || 0;
}

export async function collectStats(now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  // Окно отчёта: сутки до момента отправки (09:00 Минска), а не «с полуночи».
  const periodEnd = reportPeriodEndSec(now);
  const periodStart = periodEnd - 86400;
  const weekStart = periodEnd - 7 * 86400;

  const allUsers = await db.select().from(users).all();
  const allWatch = await db.select().from(watchItems).all();
  const allEvents = await db.select().from(events).all();
  const allNotifs = await db.select().from(notifications).all();
  const allChecks = await db.select().from(checkLog).all();

  const active = allWatch.filter((w) => w.active);
  const onSaleEvents = allEvents.filter((e) => e.onSale);
  const checksToday = allChecks.filter((c) => tsNum(c.startedAt) >= periodStart && tsNum(c.startedAt) < periodEnd);
  const inPeriod = (v) => tsNum(v) >= periodStart && tsNum(v) < periodEnd;

  return {
    date: minskDateLabel(now),
    period: {
      from: periodStart,
      to: periodEnd,
      label: `${formatShortDate(periodStart)} — ${formatShortDate(periodEnd)}`,
    },
    users: {
      total: allUsers.length,
      newToday: allUsers.filter((u) => inPeriod(u.createdAt)).length,
      active24h: allUsers.filter((u) => inPeriod(u.lastSeenAt)).length,
      active7d: allUsers.filter((u) => tsNum(u.lastSeenAt) >= weekStart && tsNum(u.lastSeenAt) < periodEnd).length,
    },
    watch: {
      total: active.length,
      newToday: allWatch.filter((w) => inPeriod(w.createdAt)).length,
      byKind: countBy(active, 'kind'),
      bySource: countBy(active, 'source'),
    },
    events: {
      total: allEvents.length,
      newToday: allEvents.filter((e) => inPeriod(e.firstSeenAt)).length,
      onSale: onSaleEvents.length,
      // Разбивка именно «в продаже» — иначе рядом с цифрой onSale стояли бы все
      // события кэша (96+58+10 = 164), и строка читалась бы неверно.
      onSaleBySource: countBy(onSaleEvents, 'source'),
      bySource: countBy(allEvents, 'source'),
    },
    notif: {
      today: allNotifs.filter((n) => inPeriod(n.sentAt)).length,
      d7: allNotifs.filter((n) => tsNum(n.sentAt) >= weekStart && tsNum(n.sentAt) < periodEnd).length,
      total: allNotifs.length,
    },
    checks: {
      today: checksToday.length,
      items: sumBy(checksToday, 'checked'),
      notified: sumBy(checksToday, 'notified'),
      failed: sumBy(checksToday, 'failed'),
      lastAt: allChecks.length ? Math.max(...allChecks.map((c) => tsNum(c.startedAt))) : 0,
      durationMsAvg: checksToday.length ? Math.round(sumBy(checksToday, 'durationMs') / checksToday.length) : 0,
      budget: budgetSummary(checksToday),
      health: healthSummary({ checksToday, allChecks, periodStart, periodEnd, now }),
    },
  };
}

// Сводка «Здоровье» — короткий блок с оценками ✅/🟡/🔴.
//
// Смысл: остальной отчёт полон цифр, но по ним нужно самому догадываться, всё ли
// в порядке (например, «отложено по бюджету 244» звучит тревожно, хотя это
// нормальная частичная обработка). Здесь каждая строка — ЗАКОНЧЕННЫЙ ВЫВОД:
// сравнение с порогом и, где есть данные, с предыдущими сутками.
//
// Пороги выбраны по фактическим замерам прода, а не «на глаз»:
//   • ошибок позиций — 0 норма, единицы допустимы (разовые таймауты);
//   • длительность цикла — интервал запуска 5–10 мин, значит 60 с это уже
//     заметно, 180 с — плохо (был баг, когда цикл занимал 280 с);
//   • свежесть — цикл не должен отставать от своего же интервала;
//   • обход площадок — 20 % от лимита это ещё норма, выше — упёрлись в таймаут.
function healthSummary({ checksToday, allChecks, periodStart, periodEnd, now }) {
  const prevStart = periodStart - 86400;
  const prevChecks = allChecks.filter((c) => tsNum(c.startedAt) >= prevStart && tsNum(c.startedAt) < periodStart);
  const n = checksToday.length;

  const avgMs = n ? Math.round(sumBy(checksToday, 'durationMs') / n) : 0;
  const maxMs = n ? Math.max(...checksToday.map((c) => tsNum(c.durationMs))) : 0;
  // МЕДИАНА, а не среднее: единичные выбросы (сетевой сбой на одном сайте растягивает
  // цикл до 400+ с) поднимают среднее вдвое и рисуют 🔴 там, где типичный цикл
  // здоров. В проде: среднее 58.8 с при медиане 28 с.
  const durations = checksToday.map((c) => tsNum(c.durationMs)).filter((v) => v > 0).sort((a, b) => a - b);
  const medianMs = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const slowCycles = durations.filter((v) => v >= 180000).length;
  const failed = sumBy(checksToday, 'failed');
  const prevFailed = sumBy(prevChecks, 'failed');

  // Пропуски площадок по троттлингу — главный показатель «дошло ли дело до площадок».
  // Сравниваем с предыдущими сутками: устойчивое снижение = починка сработала.
  const venueSkipped = sumBy(checksToday, 'queryVenuesSkipped');
  const prevVenueSkipped = sumBy(prevChecks, 'queryVenuesSkipped');
  const venueTried = sumBy(checksToday, 'queryVenuesTried');
  // Сумма за сутки — это ЧИСЛО СОБЫТИЙ, а не площадок: одна мёртвая запись,
  // которую переопрашивают каждые 1–12 часов, давала «40 битых» при четырёх
  // реальных. Показываем снимок (сколько разных площадок битые сейчас), а сумму
  // оставляем как «попыток было».
  const venueFailed = sumBy(checksToday, 'venueQueueFailed');
  const venueFailedNow = Math.max(0, ...checksToday.map((c) => tsNum(c.venueQueueFailingNow)));
  const venueRenamed = sumBy(checksToday, 'venueQueueRenamed');

  const crawl = {
    avgMs: n ? Math.round(sumBy(checksToday, 'venueCrawlMs') / n) : 0,
    runs: sumBy(checksToday, 'venueCrawlRuns'),
    timeTruncated: sumBy(checksToday, 'venueCrawlTimeTruncated'),
    budgetMs: VENUE_CRAWL_BUDGET_MS,
  };
  const crawlPct = crawl.budgetMs
    ? Math.round((sumBy(checksToday, 'venueCrawlMs') / Math.max(1, crawl.runs) / crawl.budgetMs) * 100)
    : 0;

  const budgetPct = n ? Math.round((sumBy(checksToday, 'detailSpent') / n / DETAIL_BUDGET) * 100) : 0;

  // Сколько циклов реально было: интервал в пике 3–6 мин, днём 5–10, ночью 30–60.
  // За сутки это ориентировочно 150–200 циклов; сильно меньше — значит процесс
  // простаивал или падал.
  const lastAt = allChecks.length ? Math.max(...allChecks.map((c) => tsNum(c.startedAt))) : 0;
  const lastAgeMin = lastAt ? Math.round((Math.floor(now / 1000) - lastAt) / 60) : null;

  return {
    cycles: n,
    avgMs,
    medianMs,
    maxMs,
    slowCycles,
    failed,
    prevFailed: prevChecks.length ? prevFailed : null,
    venueSkipped,
    prevVenueSkipped: prevChecks.length ? prevVenueSkipped : null,
    venueTried,
    venueFailed,
    venueFailedNow,
    venueRenamed,
    crawlPct,
    crawlTruncated: crawl.timeTruncated,
    budgetPct,
    lastAgeMin,
  };
}

// Утилизация «бюджетов опроса» за окно отчёта (см. lib/budget.js и lib/config.js).
// Для каждого ограничения считаем: сколько реально срабатывало и сколько раз
// упиралось в потолок. «Up» — нагрузка выше возможностей бюджета, «ok» — запас есть.
function budgetSummary(checks) {
  const cycles = checks.length || 1;
  const detailSpent = sumBy(checks, 'detailSpent');
  const detailDenied = sumBy(checks, 'detailDenied');
  const cityProbes = sumBy(checks, 'cityProbes');
  const cityChecks = sumBy(checks, 'cityChecks');
  const cityProbesMax = Math.max(0, ...checks.map((c) => tsNum(c.cityProbesMax)));
  const venuesTried = sumBy(checks, 'queryVenuesTried');
  const venuesSkipped = sumBy(checks, 'queryVenuesSkipped');
  const quotaHit = sumBy(checks, 'venueQuotaHit');
  // Очередь площадок (venue_queue): поставлено, ждало обхода, обойдено, битых.
  const venueQueued = sumBy(checks, 'venueQueued');
  const venueCrawled = sumBy(checks, 'venueQueueCrawled');
  const venueFailed = sumBy(checks, 'venueQueueFailed');
  const venueEarly = sumBy(checks, 'venueQueueEarly');
  const venueDeferred = sumBy(checks, 'venueQueueDeferred');
  const venueWaitingMax = Math.max(0, ...checks.map((c) => tsNum(c.venueQueueWaiting)));
  // Уведомления, отправленные без запроса к сайту (событие уже было в базе).
  const notifiedFree = sumBy(checks, 'notifiedFree');
  const crawlMs = sumBy(checks, 'venueCrawlMs');
  const crawlRuns = sumBy(checks, 'venueCrawlRuns');
  const crawlTruncated = sumBy(checks, 'venueCrawlTruncated');
  // Колонки появились вместе с разрезом причин: старые строки дают 0.
  const crawlTimeTruncated = sumBy(checks, 'venueCrawlTimeTruncated');
  const crawlBudgetTruncated = sumBy(checks, 'venueCrawlBudgetTruncated');
  const crawlDeferred = sumBy(checks, 'venueCrawlDeferred');
  const eventsTruncated = sumBy(checks, 'venueEventsTruncated');
  const resultsTruncated = sumBy(checks, 'resultsTruncated');
  // Метрики «эффективности»: что сэкономили и что пропустили осознанно.
  const cacheHits = sumBy(checks, 'searchCacheHits');
  const cacheMisses = sumBy(checks, 'searchCacheMisses');
  const cacheJoins = sumBy(checks, 'searchCacheJoins');
  const presaleSkipped = sumBy(checks, 'presaleSkipped');
  const perChatDenied = sumBy(checks, 'perChatDenied');
  // Исходы проверки позиций — видно, почему позиция осталась без запроса.
  const skippedFresh = sumBy(checks, 'skippedFresh');
  const noBudget = sumBy(checks, 'noBudget');
  const emptyResult = sumBy(checks, 'emptyResult');
  const notOnSale = sumBy(checks, 'notOnSale');
  const errorItems = sumBy(checks, 'errorItems');

  return {
    cycles: checks.length,
    items: sumBy(checks, 'checked'),
    perCycleItems: checks.length ? Math.round(sumBy(checks, 'checked') / cycles) : 0,
    // Подробные запросы за цикл могут превысить лимит: у площадок отдельный резерв
    // из того же DETAIL_BUDGET, а часть трат идёт без ограничения (известные события).
    budget: {
      limit: DETAIL_BUDGET,
      venueReserve: VENUE_BUDGET_RESERVE,
      venueLimit: DETAIL_BUDGET - VENUE_BUDGET_RESERVE,
    },
    detail: {
      limit: DETAIL_BUDGET,
      spentAvg: Math.round(detailSpent / cycles),
      // Средняя доля потраченного бюджета за цикл (0–100%).
      pct: Math.round((detailSpent / cycles / DETAIL_BUDGET) * 100),
      deniedCycles: checks.filter((c) => tsNum(c.detailDenied) > 0).length,
      denied: detailDenied,
    },
    city: {
      limit: MAX_CITY_PROBES,
      total: cityProbes,
      checks: cityChecks,
      // Среднее число городов на одну проверку события — главный показатель
      // «все города» (сколько городов реально опрашивается за раз).
      perCheck: cityChecks ? Math.round((cityProbes / cityChecks) * 10) / 10 : 0,
      max: cityProbesMax,
      avg: Math.round(cityProbes / cycles),
      // Раньше здесь стояло `cityProbes >= MAX_CITY_PROBES` по сумме за цикл —
      // такое условие выполнялось в каждом цикле, где было больше 10 проверок,
      // и «лимит достигнут» ничего не значило. Теперь — предел на одну позицию.
      saturated: checks.filter((c) => tsNum(c.cityProbesMax) >= MAX_CITY_PROBES).length,
    },
    venues: {
      perQuery: VENUE_QUEUE_PER_CYCLE,
      eventsLimit: MAX_VENUE_EVENTS,
      tried: venuesTried,
      skipped: venuesSkipped,
      quotaHit,
      eventsTruncated,
      resultsTruncated,
      // Очередь площадок.
      queued: venueQueued,
      crawled: venueCrawled,
      failed: venueFailed,
      early: venueEarly,
      deferred: venueDeferred,
      waitingMax: venueWaitingMax,
    },
    crawl: {
      budgetMs: VENUE_CRAWL_BUDGET_MS,
      runs: crawlRuns,
      avgMs: crawlRuns ? Math.round(crawlMs / crawlRuns) : 0,
      truncated: crawlTruncated,
      timeTruncated: crawlTimeTruncated,
      budgetTruncated: crawlBudgetTruncated,
      deferred: crawlDeferred,
      pct: crawlRuns ? Math.round((crawlMs / crawlRuns / VENUE_CRAWL_BUDGET_MS) * 100) : 0,
    },
    // Насколько эффективно расходуется бюджет: кэш поиска и осознанные пропуски.
    efficiency: {
      cacheHits,
      cacheMisses,
      cacheJoins,
      presaleSkipped,
      perChatDenied,
      cacheHitPct: (cacheHits + cacheMisses)
        ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 100)
        : 0,
    },
    // Почему позиции не ходили в сеть (или ходили впустую).
    outcomes: {
      skippedFresh,
      noBudget,
      emptyResult,
      notOnSale,
      errorItems,
    },
    // Уведомления, отправленные без запроса к сайту.
    notifiedFree,
  };
}

// Значок «запаса»: доля утилизации бюджета → ok / tight / over.
function loadIcon(pct) {
  if (pct >= 100) return '🔴';
  if (pct >= 70) return '🟡';
  return '🟢';
}

// «1 раз» / «2 раза» / «5 раз».
function timesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'раз';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раза';
  return 'раз';
}

// «в 1 цикле» / «в 3 циклах» — без кривого «1 циклах».
function cyclesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} цикле`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} циклах`;
  return `${n} циклах`;
}

function diffLabel(n) {
  return n > 0 ? `+${n} за сутки` : 'новых за сутки нет';
}

// Блок «Здоровье»: те же цифры, но сразу с выводом и трендом к прошлым суткам.
// Формат таблицей: «Показатель · Значение · Оценка» — так видно с одного взгляда,
// что требует внимания, а что просто работает.
function formatHealth(h) {
  if (!h || !h.cycles) return [];
  const lines = ['', '🩺 <b>Здоровье</b>'];

  const row = (label, value, icon) => {
    lines.push(`• ${label} ${icon} — ${value}`);
  };

  // Ошибки: единицы — это сетевые таймауты, а не дефект; тренд важнее числа.
  const failedTrend = h.prevFailed === null ? ''
    : h.failed === h.prevFailed ? ' (как вчера)'
      : h.failed < h.prevFailed ? ` (было ${h.prevFailed})`
        : ` (было ${h.prevFailed} — стало хуже)`;
  row('Ошибки позиций', `${h.failed} за сутки${failedTrend}`,
    h.failed === 0 ? '✅' : h.failed <= 3 ? '🟡' : '🔴');

  // Длительность: интервал запуска 5–10 мин, поэтому 60 с уже заметно.
  // Оцениваем по медиане; выбросы показываем отдельно, чтобы не пугать зря.
  const slowTail = h.slowCycles ? `, ${h.slowCycles} медленных` : '';
  row('Длительность цикла', `медиана ${(h.medianMs / 1000).toFixed(0)} с, макс ${(h.maxMs / 1000).toFixed(0)} с${slowTail}`,
    h.medianMs < 60000 ? '✅' : h.medianMs < 180000 ? '🟡' : '🔴');

  // Свежесть: цикл не должен отставать от собственного интервала.
  const age = h.lastAgeMin;
  row('Последний цикл', age === null ? 'нет данных' : `${age} мин назад`,
    age === null ? '🟡' : age <= 15 ? '✅' : age <= 60 ? '🟡' : '🔴');

  // Площадки: главный вопрос — «дошло ли дело до обхода». Считаем не «сколько
  // пропущено» (это счётчик троттлинга, он большой по определению: у каждой
  // площадки свой срок), а сколько площадок РЕАЛЬНО обошли и сколько из них
  // попали в очередь повторно. Именно это отличает «работает» от « стоит».
  const skipTrend = h.prevVenueSkipped === null ? ''
    : h.venueSkipped < h.prevVenueSkipped ? ` (было ${h.prevVenueSkipped} — стало лучше)`
      : h.venueSkipped > h.prevVenueSkipped ? ` (было ${h.prevVenueSkipped})` : ' (как вчера)';
  row('Обход площадок', `${h.venueTried} обходов${skipTrend}`,
    h.venueTried > 0 ? '✅' : '🔴');

  // Обход: сколько занимает от лимита времени.
  row('Время обхода', `${h.crawlPct}% от лимита`,
    h.crawlTruncated ? '🟡' : h.crawlPct < 50 ? '✅' : '🟡');

  // Бюджет: ниже 80 % — есть запас, у потолка — нужно поднимать.
  row('Бюджет', `${h.budgetPct}% от DETAIL_BUDGET`,
    h.budgetPct < 80 ? '✅' : h.budgetPct < 100 ? '🟡' : '🔴');

  if (h.venueFailedNow) {
    // «Сейчас» — снимок; «попыток» — сумма за сутки (не пугает, но видно масштаб).
    const tries = h.venueFailed ? `, попыток за сутки ${h.venueFailed}` : '';
    lines.push(`   ⚠️ битых площадок сейчас: ${h.venueFailedNow}${tries} (отложены с backoff)`);
  } else if (h.venueFailed) {
    lines.push(`   ℹ️ сбоев площадок за сутки: ${h.venueFailed}, сейчас все восстановлены`);
  }
  if (h.venueRenamed) {
    lines.push(`   🔧 исправлено переименованных площадок: ${h.venueRenamed}`);
  }
  return lines;
}


export function formatReport(s) {
  const kind = (k) => (s.watch.byKind[k] || 0);
  const src = (k) => (s.watch.bySource[k] || 0);
  const evSrc = (k) => (s.events.onSaleBySource?.[k] || 0);
  const lastAt = s.checks.lastAt ? formatTimeMinsk(s.checks.lastAt) : '—';

  const lines = [];
  lines.push(`📊 <b>Статистика бота</b> — ${s.date}`);
  lines.push(`<i>за период ${s.period.label}</i>`);
  lines.push('');
  lines.push(`👥 <b>Пользователи</b>`);
  lines.push(`• Всего: <b>${s.users.total}</b> (${diffLabel(s.users.newToday)})`);
  lines.push(`• Активных: 24 ч — ${s.users.active24h}, 7 дней — ${s.users.active7d}`);
  lines.push('');
  lines.push(`👀 <b>Отслеживание</b>`);
  lines.push(`• Позиций: <b>${s.watch.total}</b> (${diffLabel(s.watch.newToday)})`);
  lines.push(`• По типу: ключевых слов ${kind('query')}, событий ${kind('event')}, площадок ${kind('venue')}`);
  lines.push(`• По источнику: все ${src('all')}, Афиша ${src('afisha')}, Ticketpro ${src('ticketpro')}, BezKassira ${src('bezkassira')}`);
  lines.push('');
  lines.push(`🎟 <b>События</b>`);
  lines.push(`• В базе: <b>${s.events.total}</b> (${diffLabel(s.events.newToday)})`);
  lines.push(`• В продаже сейчас: <b>${s.events.onSale}</b> (Афиша ${evSrc('afisha')}, Ticketpro ${evSrc('ticketpro')}, BezKassira ${evSrc('bezkassira')})`);
  lines.push('');
  lines.push(`🔔 <b>Уведомления</b>`);
  lines.push(`• За сутки: <b>${s.notif.today}</b> · за 7 суток: ${s.notif.d7} · всего: ${s.notif.total}`);
  lines.push('');
  lines.push(`⚙️ <b>Проверки</b>`);
  lines.push(`• Циклов за сутки: <b>${s.checks.today}</b>`);
  lines.push(`• Проверено позиций: ${s.checks.items} · уведомлений: ${s.checks.notified} · ошибок: ${s.checks.failed}`);
  lines.push(`• Последняя проверка: ${lastAt}`);
  lines.push(...formatHealth(s.checks.health));
  lines.push(...formatBudget(s.checks.budget));
  return lines.join('\n');
}

// Блок «Бюджеты опроса»: сколько из каждого лимита реально тратится и где запас.
// Показываем только то, что реально происходило за сутки (иначе шум в отчёте).
function formatBudget(b) {
  const lines = ['', `📈 <b>Бюджеты опроса</b>`];
  if (!b || !b.cycles) {
    lines.push('• Данных пока нет (учёт начал собираться с этого релиза)');
    return lines;
  }
  lines.push(`• Позиций за цикл: в среднем ${b.perCycleItems}`);

  // DETAIL_BUDGET — главный лимит: он «общий» на все детальные запросы, но часть
  // его зарезервирована под площадки (VENUE_BUDGET_RESERVE).
  const d = b.detail;
  const denied = d.deniedCycles
    ? `, отказ в ${cyclesWord(d.deniedCycles)} (${d.denied} отложено)`
    : ', отказов не было';
  const split = b.budget
    ? ` (обычные ${b.budget.venueLimit} + площадки ${b.budget.venueReserve})`
    : '';
  lines.push(`• DETAIL_BUDGET ${loadIcon(d.pct)} ${d.spentAvg}/${d.limit} за цикл (${d.pct}%)${split}${denied}`);

  if (b.city.total || b.city.checks) {
    const perCheck = b.city.perCheck
      ? `, ${b.city.perCheck} города на проверку`
      : '';
    const sat = b.city.saturated
      ? `, предел на проверку (${b.city.limit}) достигнут в ${cyclesWord(b.city.saturated)}`
      : '';
    lines.push(`• Города: ${b.city.total} запросов за сутки${perCheck} (макс. ${b.city.max || 0} на проверку${sat})`);
  }

  const v = b.venues;
  if (v.tried || v.skipped || v.queued || v.crawled) {
    // Раньше здесь была строка «пропущено по троттлингу N» — она описывала баг,
    // а не работу: площадка, до которой не дошли, терялась до следующего цикла.
    // Теперь площадки не теряются, а ждут в очереди с dueAt, поэтому показываем
    // очередь: сколько поставлено, сколько реально обошли и сколько ждёт.
    const parts = [`обошли ${v.crawled || v.tried}`];
    if (v.early) parts.push(`заранее ${v.early}`);
    if (v.queued) parts.push(`новых в очередь ${v.queued}`);
    if (v.waitingMax) parts.push(`ждут обхода до ${v.waitingMax}`);
    if (v.deferred) parts.push(`отложено по бюджету ${v.deferred}`);
    if (v.failed) parts.push(`битых ${v.failed} (с backoff)`);
    lines.push(`• Площадки: ${parts.join(' · ')}`);
  }
  if (v.eventsTruncated) {
    lines.push(`   ⚠️ MAX_VENUE_EVENTS (${v.eventsLimit}) упирался ${v.eventsTruncated} ${timesWord(v.eventsTruncated)} — часть событий площадок не проверялась`);
  }
  if (v.resultsTruncated) {
    lines.push(`   ⚠️ поиск отдал больше MAX_RESULTS_PER_QUERY (10) результатов (${v.resultsTruncated} ${timesWord(v.resultsTruncated)}) — хвост не проверялся`);
  }

  if (b.crawl.runs) {
    // Причины прерывания раздельные: раньше «по времени» писалось и тогда, когда
    // обход вообще не начинался (кончился DETAIL_BUDGET) — отсюда было «0 мс и
    // прерван по времени 72 раза». Теперь показываем только реальное время, а
    // мгновенные прерывания по бюджету обходим отдельной строкой ниже.
    const icon = b.crawl.timeTruncated ? loadIcon(b.crawl.pct) : '🟢';
    const tr = b.crawl.timeTruncated
      ? `, по времени прерван ${b.crawl.timeTruncated} ${timesWord(b.crawl.timeTruncated)}`
      : ', по времени не прерывался';
    lines.push(`• Обход площадок ${icon} ${b.crawl.avgMs}/${b.crawl.budgetMs} мс (${b.crawl.pct}%)${tr}`);
    if (b.crawl.budgetTruncated) {
      const tail = b.crawl.deferred ? ` (${b.crawl.deferred} отложено)` : '';
      lines.push(`   ⚠️ обход прерван из-за бюджета ${b.crawl.budgetTruncated} ${timesWord(b.crawl.budgetTruncated)}${tail} — часть площадок не проверена`);
    }
  }

  // Эффективность: кэш поиска + осознанные пропуски. Показываем только когда
  // есть данные — старые строки check_log по этим колонкам дают 0.
  const eff = b.efficiency;
  if (eff && (eff.cacheHits || eff.cacheMisses)) {
    const joined = eff.cacheJoins ? `, присоединились к запросу ${eff.cacheJoins}` : '';
    lines.push(`• Кэш поиска ${loadIcon(100 - eff.cacheHitPct)} ${eff.cacheHits} попаданий / ${eff.cacheMisses} промахов (${eff.cacheHitPct}% — сэкономленные запросы)${joined}`);
  }
  // Уведомления без запроса к сайту: событие уже было в базе и в продаже.
  if (b.notifiedFree) {
    lines.push(`• Уведомлений без запроса к сайту: ${b.notifiedFree} (событие уже в базе)`);
  }
  if (eff && eff.presaleSkipped) {
    lines.push(`• Не перечитывались (не в продаже, старт дальше горизонта): ${eff.presaleSkipped}`);
  }
  if (eff && eff.perChatDenied) {
    lines.push(`• Отказы по лимиту на пользователя: ${eff.perChatDenied} (равномерная раздача бюджета)`);
  }

  // Исходы позиций: почему не было запроса и сколько запросов было впустую.
  const o = b.outcomes;
  if (o && (o.skippedFresh || o.noBudget || o.emptyResult || o.notOnSale || o.errorItems)) {
    const parts = [];
    if (o.skippedFresh) parts.push(`свежие ${o.skippedFresh}`);
    if (o.noBudget) parts.push(`без бюджета ${o.noBudget}`);
    if (o.notOnSale) parts.push(`не в продаже ${o.notOnSale}`);
    if (o.emptyResult) parts.push(`пустой ответ ${o.emptyResult}`);
    if (o.errorItems) parts.push(`ошибки ${o.errorItems}`);
    lines.push(`• Исходы позиций: ${parts.join(' · ')}`);
    if (o.noBudget && o.noBudget > (b.perCycleItems || 0)) {
      lines.push('   ⚠️ позиции чаще откладываются, чем проверяются — бюджета не хватает');
    }
  }
  return lines;
}

export async function sendStatsReport(chatId = STATS_CHAT_ID) {
  const stats = await collectStats();
  await api.sendMessage({
    chat_id: chatId,
    text: formatReport(stats),
    parse_mode: 'HTML',
  });
}

/**
 * Компактный диагностический снимок для AI-разбора (см. lib/ai-report.js).
 *
 * Отдаём НЕ готовый текст отчёта, а структуру: модель лучше работает с числами,
 * когда рядом подписано, что это, и когда есть база для сравнения. Плюс то, чего
 * в отчёте нет: тренд за неделю и конкретные «где болит» (битые площадки,
 * позиции без проверки).
 *
 * Возвращает простой объект — его и сериализуем в JSON для промпта.
 */
export async function collectDiagnostics(now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const periodEnd = reportPeriodEndSec(now);
  const periodStart = periodEnd - 86400;

  const allChecks = await db.select().from(checkLog).all();
  const allWatch = await db.select().from(watchItems).all();
  const allEvents = await db.select().from(events).all();
  const allNotifs = await db.select().from(notifications).all();

  // Тренд: по одному «срезу» на сутки назад (AI_TREND_DAYS дней, включая сегодня).
  const trend = [];
  for (let d = 0; d < AI_TREND_DAYS; d++) {
    const end = periodEnd - d * 86400;
    const start = end - 86400;
    const day = allChecks.filter((c) => tsNum(c.startedAt) >= start && tsNum(c.startedAt) < end);
    if (!day.length) continue;
    const durations = day.map((c) => tsNum(c.durationMs)).filter((v) => v > 0).sort((a, b) => a - b);
    trend.push({
      date: new Date(end * 1000).toISOString().slice(0, 10),
      cycles: day.length,
      failed: sumBy(day, 'failed'),
      spentAvg: Math.round(sumBy(day, 'detailSpent') / day.length),
      budgetPct: Math.round((sumBy(day, 'detailSpent') / day.length / DETAIL_BUDGET) * 100),
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : 0,
      venuesCrawled: sumBy(day, 'queryVenuesTried'),
      venuesDeferred: sumBy(day, 'venueQueueDeferred'),
      venuesFailed: sumBy(day, 'venueQueueFailed'),
      venuesRenamed: sumBy(day, 'venueQueueRenamed'),
      cacheHitPct: (() => {
        const h = sumBy(day, 'searchCacheHits');
        const m = sumBy(day, 'searchCacheMisses');
        return h + m ? Math.round((h / (h + m)) * 100) : 0;
      })(),
      notified: allNotifs.filter((n) => tsNum(n.sentAt) >= start && tsNum(n.sentAt) < end).length,
      noBudget: sumBy(day, 'noBudget'),
      presaleSkipped: sumBy(day, 'presaleSkipped'),
    });
  }

  // Проблемные площадки — конкретика, а не только число.
  const queue = await db.select().from(venueQueue).all();
  const failingVenues = [...new Set(queue.filter((r) => r.failing).map((r) => r.url))]
    .slice(0, 10)
    .map((url) => {
      const rows = queue.filter((r) => r.url === url);
      return { url, rows: rows.length, dueInMin: Math.round((Math.min(...rows.map((r) => r.dueAt)) - nowSec) / 60) };
    });
  const waitingVenues = queue.filter((r) => r.dueAt <= nowSec).length;

  // Позиции, которые давно не проверялись (потенциально «мёртвые» подписки).
  const staleItems = allWatch
    .filter((w) => w.active)
    .map((w) => ({ id: w.id, kind: w.kind, query: w.query, deferStreak: Number(w.deferStreak) || 0, checkedAgo: w.lastCheckedAt ? Math.round((nowSec - tsNum(w.lastCheckedAt)) / 3600) : null }))
    .filter((w) => w.checkedAgo === null || w.checkedAgo > 24)
    .slice(0, 10);

  const activeWatch = allWatch.filter((w) => w.active);
  const onSale = allEvents.filter((e) => e.onSale);
  const today = allChecks.filter((c) => tsNum(c.startedAt) >= periodStart && tsNum(c.startedAt) < periodEnd);
  const stale = onSale.filter((e) => {
    const s = tsNum(e.startsAt);
    return s > 0 && s < nowSec - PAST_EVENT_GRACE_SEC;
  });

  return {
    generatedAt: new Date(now).toISOString(),
    limits: {
      detailBudget: DETAIL_BUDGET,
      venueReserve: VENUE_BUDGET_RESERVE,
      venueQueuePerCycle: VENUE_QUEUE_PER_CYCLE,
      crawlBudgetMs: VENUE_CRAWL_BUDGET_MS,
    },
    today: {
      cycles: today.length,
      failed: sumBy(today, 'failed'),
      itemsChecked: sumBy(today, 'checked'),
      notified: allNotifs.filter((n) => tsNum(n.sentAt) >= periodStart && tsNum(n.sentAt) < periodEnd).length,
      budgetPct: today.length ? Math.round((sumBy(today, 'detailSpent') / today.length / DETAIL_BUDGET) * 100) : 0,
    },
    users: { total: (await db.select().from(users).all()).length },
    watch: {
      total: activeWatch.length,
      byKind: countBy(activeWatch, 'kind'),
    },
    events: {
      total: allEvents.length,
      onSale: onSale.length,
      staleOnSale: stale.length,
      neverChecked: allEvents.filter((e) => !e.lastCheckedAt).length,
    },
    venues: {
      queued: queue.length,
      // failing — это СТРОКИ (по строке на пару «позиция, площадка»), а failingUrls —
      // реально битые АДРЕСА. Разница важна: две строки одного драмтеатра от двух
      // пользователей дадут failing=2 при failingUrls=1, и это не баг дедупликации.
      failing: queue.filter((r) => r.failing).length,
      failingUrls: new Set(queue.filter((r) => r.failing).map((r) => r.url)).size,
      waiting: waitingVenues,
      failingList: failingVenues,
    },
    problems: { staleItems },
    trend,
  };
}

// Отправка с защитой от дублей: один отчёт в день (по Минску), ключ в meta.
const LAST_STATS_KEY = 'lastStatsDay';

export async function sendDailyStats() {
  const todayKey = minskDateKey();
  const row = await db.select().from(meta).where(eq(meta.key, LAST_STATS_KEY)).get();
  if (row && row.value === todayKey) return { skipped: true };

  await sendStatsReport(STATS_CHAT_ID);

  // Отметка дня ставится ДО AI-разбора: разбор — необязательное дополнение,
  // его сбой не должен приводить к повторной отправке базового отчёта.
  await db
    .insert(meta)
    .values({ key: LAST_STATS_KEY, value: todayKey })
    .onConflictDoUpdate({ target: meta.key, set: { value: todayKey } })
    .run();

  const ai = await sendAiReport(STATS_CHAT_ID);
  return { sent: true, ...ai };
}

/**
 * Дополнительное сообщение с AI-разбором статистики.
 *
 * Отдельное сообщение, а не часть основного отчёта: если модель недоступна
 * или отвечает мусором, обычная статистика всё равно доходит. Ни при каких
 * условиях эта функция не бросает исключение наружу.
 */
export async function sendAiReport(chatId = STATS_CHAT_ID) {
  if (!aiReportEnabled()) return { ai: false };
  try {
    const diagnostics = await collectDiagnostics();
    const text = await requestAiReport(diagnostics);
    if (!text) return { ai: false };
    // Без parse_mode: разбор — вольный текст модели, HTML-экранировать его
    // целиком проще, чем отлаживать сломанную разметку в отчёте.
    await api.sendMessage({
      chat_id: chatId,
      text: `🤖 <b>Разбор</b>\n\n${escapeHtml(text)}`,
      parse_mode: 'HTML',
    });
    return { ai: true };
  } catch (err) {
    console.warn(`[stats] AI-разбор не отправлен: ${err?.message || err}`);
    return { ai: false };
  }
}
