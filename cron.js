// Демон-процесс для контейнера cron (docker-compose сервис `cron`).
// Каждые CHECK_INTERVAL_MIN минут (из env, по умолчанию 15) запускает цикл
// проверки билетов через runCheck. Работает в бесконечном цикле — не требует
// внешнего cron/crond.
import { runCheck } from './lib/checker.js';

const INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN || 15) || 15;
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000;

async function tick() {
  const started = Date.now();
  try {
    const res = await runCheck({ force: process.env.CHECK_FORCE === '1' });
    console.log(`[cron] ${new Date().toISOString()} check:`, JSON.stringify(res), `in ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[cron] ${new Date().toISOString()} check failed:`, err && err.message || err);
  }
}

console.log(`[cron] starting; check every ${INTERVAL_MIN} min`);
// сразу запускаем первый цикл, затем по таймеру
tick();
setInterval(tick, INTERVAL_MS);
