// Сбор и отправка ежедневной статистики владельцу бота (чат STATS_CHAT_ID).
// Считаем пользователей, отслеживание, события, уведомления и циклы проверки.
import db from '../db.js';
import { api } from '../api.js';
import { users, watchItems, events, notifications, checkLog, meta } from '../schema.js';
import { eq } from '../db.js';
import { STATS_CHAT_ID } from './config.js';

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
  const dayStart = todayStartSec(now);
  const day1 = nowSec - 86400;
  const day7 = nowSec - 7 * 86400;

  const allUsers = await db.select().from(users).all();
  const allWatch = await db.select().from(watchItems).all();
  const allEvents = await db.select().from(events).all();
  const allNotifs = await db.select().from(notifications).all();
  const allChecks = await db.select().from(checkLog).all();

  const active = allWatch.filter((w) => w.active);
  const checksToday = allChecks.filter((c) => tsNum(c.startedAt) >= dayStart);

  return {
    date: minskDateLabel(now),
    users: {
      total: allUsers.length,
      newToday: allUsers.filter((u) => tsNum(u.createdAt) >= dayStart).length,
      active24h: allUsers.filter((u) => tsNum(u.lastSeenAt) >= day1).length,
      active7d: allUsers.filter((u) => tsNum(u.lastSeenAt) >= day7).length,
    },
    watch: {
      total: active.length,
      newToday: allWatch.filter((w) => tsNum(w.createdAt) >= dayStart).length,
      byKind: countBy(active, 'kind'),
      bySource: countBy(active, 'source'),
    },
    events: {
      total: allEvents.length,
      newToday: allEvents.filter((e) => tsNum(e.firstSeenAt) >= dayStart).length,
      onSale: allEvents.filter((e) => e.onSale).length,
      bySource: countBy(allEvents, 'source'),
    },
    notif: {
      today: allNotifs.filter((n) => tsNum(n.sentAt) >= dayStart).length,
      d7: allNotifs.filter((n) => tsNum(n.sentAt) >= day7).length,
      total: allNotifs.length,
    },
    checks: {
      today: checksToday.length,
      items: sumBy(checksToday, 'checked'),
      notified: sumBy(checksToday, 'notified'),
      failed: sumBy(checksToday, 'failed'),
      lastAt: allChecks.length ? Math.max(...allChecks.map((c) => tsNum(c.startedAt))) : 0,
    },
  };
}

function diffLabel(n) {
  return n > 0 ? `+${n} сегодня` : 'новых сегодня нет';
}

export function formatReport(s) {
  const kind = (k) => (s.watch.byKind[k] || 0);
  const src = (k) => (s.watch.bySource[k] || 0);
  const evSrc = (k) => (s.events.bySource[k] || 0);
  const lastAt = s.checks.lastAt ? formatTimeMinsk(s.checks.lastAt) : '—';

  const lines = [];
  lines.push(`📊 <b>Статистика бота</b> — ${s.date}`);
  lines.push('');
  lines.push(`👥 <b>Пользователи</b>`);
  lines.push(`• Всего: <b>${s.users.total}</b> (${diffLabel(s.users.newToday)})`);
  lines.push(`• Активных: 24 ч — ${s.users.active24h}, 7 дней — ${s.users.active7d}`);
  lines.push('');
  lines.push(`👀 <b>Отслеживание</b>`);
  lines.push(`• Позиций: <b>${s.watch.total}</b> (${diffLabel(s.watch.newToday)})`);
  lines.push(`• По типу: ключевых слов ${kind('query')}, событий ${kind('event')}, площадок ${kind('venue')}`);
  lines.push(`• По источнику: все ${src('all')}, Афиша ${src('afisha')}, Ticketpro ${src('ticketpro')}`);
  lines.push('');
  lines.push(`🎟 <b>События</b>`);
  lines.push(`• В базе: <b>${s.events.total}</b> (${diffLabel(s.events.newToday)})`);
  lines.push(`• В продаже сейчас: <b>${s.events.onSale}</b> (Афиша ${evSrc('afisha')}, Ticketpro ${evSrc('ticketpro')})`);
  lines.push('');
  lines.push(`🔔 <b>Уведомления</b>`);
  lines.push(`• Сегодня: <b>${s.notif.today}</b> · за 7 дней: ${s.notif.d7} · всего: ${s.notif.total}`);
  lines.push('');
  lines.push(`⚙️ <b>Проверки</b>`);
  lines.push(`• Циклов сегодня: <b>${s.checks.today}</b>`);
  lines.push(`• Проверено позиций: ${s.checks.items} · уведомлений: ${s.checks.notified} · ошибок: ${s.checks.failed}`);
  lines.push(`• Последняя проверка: ${lastAt}`);
  return lines.join('\n');
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
