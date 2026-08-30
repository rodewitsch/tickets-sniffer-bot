// Утилита: настраивает webhook Telegram на ваш droplet.
// Использование:
//   BOT_TOKEN=... npm run set-webhook -- https://bot.example.com/webhook
import { BOT_TOKEN, API_HOST } from '../env.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npm run set-webhook -- https://<your-domain>/webhook');
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set (env). Set it before running.');
  process.exit(1);
}

const allowed = ['message', 'callback_query'].join('","');
const res = await fetch(`https://${API_HOST}/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
process.exit(body && body.ok ? 0 : 1);
