// Сбор и отправка ежедневной статистики владельцу бота (чат STATS_CHAT_ID).
// Считаем пользователей, отслеживание, события, уведомления и циклы проверки.
import db from '../db.js';
import { api } from '../api.js';
import { users, watchItems, events, notifications, checkLog, meta } from '../schema.js';
import { eq } from '../db.js';
import { STATS_CHAT_ID, STATS_SEND_HOUR, STATS_SEND_MINUTE, DETAIL_BUDGET, VENUE_BUDGET_RESERVE, MAX_CITY_PROBES, MAX_VENUE_RESULTS_PER_QUERY, MAX_VENUE_EVENTS, VENUE_CRAWL_BUDGET_MS } from './config.js';

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
    },
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
  const crawlMs = sumBy(checks, 'venueCrawlMs');
  const crawlRuns = sumBy(checks, 'venueCrawlRuns');
  const crawlTruncated = sumBy(checks, 'venueCrawlTruncated');
  // Колонки появились вместе с разрезом причин: старые строки дают 0.
  const crawlTimeTruncated = sumBy(checks, 'venueCrawlTimeTruncated');
  const crawlBudgetTruncated = sumBy(checks, 'venueCrawlBudgetTruncated');
  const crawlDeferred = sumBy(checks, 'venueCrawlDeferred');
  const eventsTruncated = sumBy(checks, 'venueEventsTruncated');
  const resultsTruncated = sumBy(checks, 'resultsTruncated');

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
      perQuery: MAX_VENUE_RESULTS_PER_QUERY,
      eventsLimit: MAX_VENUE_EVENTS,
      tried: venuesTried,
      skipped: venuesSkipped,
      quotaHit,
      eventsTruncated,
      resultsTruncated,
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
  if (v.tried || v.skipped) {
    const parts = [`обошли ${v.tried}`, `пропущено по троттлингу ${v.skipped}`];
    if (v.quotaHit) parts.push(`лимит ${v.perQuery} площадок упёрся ${v.quotaHit} ${timesWord(v.quotaHit)}`);
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

// Отправка с защитой от дублей: один отчёт в день (по Минску), ключ в meta.
const LAST_STATS_KEY = 'lastStatsDay';

export async function sendDailyStats() {
  const todayKey = minskDateKey();
  const row = await db.select().from(meta).where(eq(meta.key, LAST_STATS_KEY)).get();
  if (row && row.value === todayKey) return { skipped: true };

  await sendStatsReport(STATS_CHAT_ID);
  await db
    .insert(meta)
    .values({ key: LAST_STATS_KEY, value: todayKey })
    .onConflictDoUpdate({ target: meta.key, set: { value: todayKey } })
    .run();
  return { sent: true };
}
