// Демон-процесс для контейнера cron (docker-compose сервис `cron`).
// Запускает цикл проверки билетов через runCheck со случайным интервалом,
// чтобы не триггерить антибот-фильтры/файерволы билетных сайтов:
//   день 9:00–21:00 → 15–30 минут, ночь → 60–120 минут.
// Часовой пояс задаётся через TZ в docker-compose (Europe/Minsk).
// Работает в бесконечном цикле — не требует внешнего cron/crond.
import { runCheck } from './lib/checker.js';

const DAY_START = 9;                     // начало «дня», час (включительно)
const DAY_END = 21;                      // конец «дня», час (не включительно)
const DAY_MIN = 15, DAY_MAX = 30;        // границы интервала днём (минуты)
const NIGHT_MIN = 60, NIGHT_MAX = 120;   // границы интервала ночью (минуты)

// Случайная задержка до следующего цикла в зависимости от текущего локального часа.
function nextDelayMinutes() {
  const h = new Date().getHours();
  const isDay = h >= DAY_START && h < DAY_END;
  const [lo, hi] = isDay ? [DAY_MIN, DAY_MAX] : [NIGHT_MIN, NIGHT_MAX];
  return Math.round(lo + Math.random() * (hi - lo));
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
  const mins = nextDelayMinutes();
  const ms = mins * 60 * 1000;
  console.log(`[cron] next check in ${mins} min (at ${new Date(Date.now() + ms).toISOString()})`);
  setTimeout(tick, ms);
}

console.log('[cron] starting with randomized interval (day 9-21: 15-30 min, night: 60-120 min)');
// сразу запускаем первый цикл, дальше — по случайному таймеру
tick();
