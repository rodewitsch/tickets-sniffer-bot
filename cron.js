// Демон-процесс для контейнера cron (docker-compose сервис `cron`).
// Запускает цикл проверки билетов через runCheck со случайным интервалом,
// чтобы не триггерить антибот-фильтры/файерволы билетных сайтов:
//   день 9:00–21:00 → 15–30 минут, ночь → 60–120 минут.
// Часовой пояс задаётся через TZ в docker-compose (Europe/Minsk).
// Работает в бесконечном цикле — не требует внешнего cron/crond.
import { runCheck } from './lib/checker.js';
import { sendDailyStats, msUntilNextMinsk, minskParts } from './lib/stats.js';
import { STATS_SEND_HOUR, STATS_SEND_MINUTE } from './lib/config.js';
import { runMigrations } from './migrate.js';

// Миграции при старте. Раньше их применял только server.js, а cron запускается
// отдельным контейнером и писал в check_log раньше, чем bot успевал обновить
// схему: новые колонки отсутствовали, insert падал, цикл не логировался.
// cron не должен зависеть от порядка старта соседнего контейнера.
try {
  runMigrations();
} catch (err) {
  console.error('[cron] migrate on startup failed:', err && err.message || err);
}

// Интервалы опроса. Бот должен ловить старт продаж РАНЬШЕ пользователя,
// поэтому днём опрос частый; ночью (когда всё спят и сайты не обновляют)
// реже — это ещё и защита от бан-фильтров.
const DAY_START = 9;                     // начало «дня», час (включительно)
const DAY_END = 21;                      // конец «дня», час (не включительно)
const DAY_MIN = 5, DAY_MAX = 10;         // днём: 5–10 минут
const PEAK_START = 17;                   // вечерний пик (после работы) — 17:00
const PEAK_END = 21;                     // до 21:00
const PEAK_MIN = 3, PEAK_MAX = 6;        // в пик: 3–6 минут
const NIGHT_MIN = 30, NIGHT_MAX = 60;    // ночью: 30–60 минут

// Случайная задержка до следующего цикла в зависимости от текущего часа Минска.
// Используем minskParts().hour (Intl, TZ-aware), а не new Date().getHours():
// в node:22-alpine без tzdata getHours() вернул бы UTC, и дневной интервал
// 15–30 мин превратился бы в ночной 60–120 мин.
function nextDelayMinutes() {
  const h = minskParts().hour;
  let lo;
  let hi;
  let label;
  if (h >= PEAK_START && h < PEAK_END) {
    [lo, hi] = [PEAK_MIN, PEAK_MAX];
    label = 'peak';
  } else if (h >= DAY_START && h < DAY_END) {
    [lo, hi] = [DAY_MIN, DAY_MAX];
    label = 'day';
  } else {
    [lo, hi] = [NIGHT_MIN, NIGHT_MAX];
    label = 'night';
  }
  return { minutes: Math.round(lo + Math.random() * (hi - lo)), label };
}

async function tick() {
  const started = Date.now();
  try {
    const res = await runCheck({ force: process.env.CHECK_FORCE === '1' });
    console.log(`[cron] ${new Date().toISOString()} check:`, JSON.stringify(res), `in ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[cron] ${new Date().toISOString()} check failed:`, err && err.message || err);
  }
  scheduleNext();
}

function scheduleNext() {
  const { minutes, label } = nextDelayMinutes();
  const ms = minutes * 60 * 1000;
  console.log(`[cron] next check in ${minutes} min (${label}) at ${new Date(Date.now() + ms).toISOString()}`);
  setTimeout(tick, ms);
}

console.log('[cron] starting (peak 3-6 min, day 5-10 min, night 30-60 min)');
// сразу запускаем первый цикл, дальше — по случайному таймеру
tick();

// --- Ежедневная статистика: отправка владельцу в 9:00 по Минску ---

async function sendStats() {
  try {
    const res = await sendDailyStats();
    console.log(`[cron] ${new Date().toISOString()} daily stats:`, JSON.stringify(res));
  } catch (err) {
    console.error(`[cron] ${new Date().toISOString()} daily stats failed:`, err && err.message || err);
  }
  scheduleNextStats();
}

function scheduleNextStats() {
  const ms = msUntilNextMinsk(STATS_SEND_HOUR, STATS_SEND_MINUTE);
  console.log(`[cron] daily stats in ${Math.round(ms / 60000)} min (at ${new Date(Date.now() + ms).toISOString()})`);
  setTimeout(sendStats, ms);
}

// Catch-up: если cron перезапустился уже после времени отправки — шлём сразу
// (внутренний guard по meta не даст дубль за сегодня), затем встаём на завтра.
const statsNow = minskParts();
const statsPassed = statsNow.hour * 60 + statsNow.minute >= STATS_SEND_HOUR * 60 + STATS_SEND_MINUTE;
if (statsPassed) {
  console.log('[cron] daily stats: past send time, catch-up in 10s');
  setTimeout(sendStats, 10_000);
} else {
  scheduleNextStats();
}
