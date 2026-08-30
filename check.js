// Точка входа крон-проверки билетов на Droplet. Запуск (например в cron-контейнере
// или вручную):
//   node check.js [force]
// Или через HTTP: curl "http://127.0.0.1:8080/check?secret=..."
import { runCheck } from './lib/checker.js';

export async function runScheduledCheck(force) {
  const res = await runCheck({ force: !!force });
  console.log('check cycle result:', JSON.stringify(res));
  return res;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const force = process.argv[2] === 'force';
  runScheduledCheck(force)
    .then((res) => {
      process.exit(res ? 0 : 1);
    })
    .catch((err) => {
      console.error('check failed', err);
      process.exit(1);
    });
}
