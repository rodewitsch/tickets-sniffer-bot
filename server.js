// HTTP-сервер вебхука для DigitalOcean Droplet.
// Маршруты:
//   POST /webhook   — принимает Update от Telegram и маршрутизирует по типу
//   GET  /check     — запуск цикла проверки билетов (для внешнего крона/systemd timer)
//   GET  /health    — healthcheck
//   static miniapp  — опционально раздаёт мини-приложение по / (если включено)
//
// Запуск:  node server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, CHECK_SECRET } from './env.js';
import { runCheck } from './lib/checker.js';
import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIAPP_DIR = path.join(__dirname, 'miniapp');

// Динамические импорты хендлеров: каждый модуль экспортирует `default(update[type])`.
async function loadHandler(type) {
  try {
    const mod = await import(`./handlers/${type}.js`);
    return mod.default;
  } catch {
    return null; // нет хендлера для этого типа — игнорируем
  }
}

// Диспетчер: по типу апдейта выбираем хендлер и вызываем его с payload.
async function dispatchUpdate(update) {
  const typeToKey = {
    message: 'message',
    edited_message: 'edited_message',
    channel_post: 'channel_post',
    edited_channel_post: 'edited_channel_post',
    inline_query: 'inline_query',
    chosen_inline_result: 'chosen_inline_result',
    callback_query: 'callback_query',
    shipping_query: 'shipping_query',
    pre_checkout_query: 'pre_checkout_query',
    poll: 'poll',
    poll_answer: 'poll_answer',
    my_chat_member: 'my_chat_member',
    chat_member: 'chat_member',
    chat_join_request: 'chat_join_request',
  };

  for (const [type, key] of Object.entries(typeToKey)) {
    if (update[key] !== undefined) {
      const handler = await loadHandler(type);
      if (handler) {
        await handler(update[key], { update });
        return true;
      }
      return false; // тип есть, но хендлер не предусмотрен
    }
  }
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleWebhook(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let update;
  try {
    update = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
  }

  // Всегда отвечаем 200 до обработки, чтобы Telegram не ретраил; обработку
  // можно делать в фоне. Но по умолчанию выполняем синхронно и отвечаем после.
  const uwd = update.message && update.message.web_app_data;
  console.log('[webhook] update', update.update_id, 'types:', Object.keys(update).filter(k => update[k] !== undefined && k !== 'update_id').join(','), 'chat:', update.message && update.message.chat && update.message.chat.id, 'web_app_data:', uwd ? 'YES len=' + (uwd.data || '').length : 'no');
  try {
    await dispatchUpdate(update);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('webhook handler error:', err);
    sendJson(res, 200, { ok: false, error: 'handler_error' });
  }
}

async function handleCheck(req, res, url) {
  const secret = url.searchParams.get('secret') || '';
  if (CHECK_SECRET && secret !== CHECK_SECRET) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  try {
    const result = await runCheck({ force: true });
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error('cron check error:', err);
    sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
  }
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(MINIAPP_DIR, rel));
  if (!file.startsWith(MINIAPP_DIR)) return false;
  try {
    const body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/webhook' && (req.method === 'POST' || req.method === 'GET')) {
      return await handleWebhook(req, res);
    }
    if (url.pathname === '/check' && req.method === 'GET') {
      return await handleCheck(req, res, url);
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }
    if (process.env.SERVE_STATIC === '1' && req.method === 'GET') {
      const served = await serveStatic(res, url.pathname);
      if (served) return;
    }
    sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    console.error('server error:', err);
    try { sendJson(res, 500, { ok: false, error: 'server_error' }); } catch {}
  }
});

// Миграция (создание таблиц) при старте — удобно для первого запуска.
try {
  runMigrations();
} catch (err) {
  console.error('migrate on startup failed:', err);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
});
