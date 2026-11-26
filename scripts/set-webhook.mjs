// Утилита: настраивает webhook Telegram на ваш droplet.
// Использование:
//   BOT_TOKEN=... npm run set-webhook -- https://bot.example.com/webhook
import { BOT_TOKEN, API_HOST, WEBHOOK_SECRET } from '../env.js';

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
    // Секрет → Telegram будет присылать его в X-Telegram-Bot-Api-Secret-Token,
    // а server.js отвергнет POST без него (см. lib/telegram-auth.js).
    // Telegram требует 1–256 символов A-Za-z0-9_-: пустую строку не шлём.
    ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {}),
  }),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
process.exit(body && body.ok ? 0 : 1);
