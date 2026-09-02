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
import { fetchEventCities, AFISHA_HOSTS } from './lib/sources/afisha.js';
import { searchTicketpro, searchTicketproVenues, enrichTicketproCategories } from './lib/sources/ticketpro.js';
import { searchBezkassira, fetchBezkassiraOrganizer, enrichBezkassiraCategories } from './lib/sources/bezkassira.js';
import { cityLabel } from './lib/cities.js';

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

  const uwd = update.message && update.message.web_app_data;
  const txt = update.message && update.message.text;
  console.log('[webhook] update', update.update_id, 'types:', Object.keys(update).filter(k => update[k] !== undefined && k !== 'update_id').join(','), 'chat:', update.message && update.message.chat && update.message.chat.id, 'web_app_data:', uwd ? 'YES len=' + (uwd.data || '').length : 'no', txt ? ('text: ' + String(txt).slice(0,80)) : '');

  // Отвечаем 200 Telegram СРАЗУ и обрабатываем апдейт в фоне. Если обработка
  // (особенно /check) идёт долго, Telegram ждёт ответ вебхука и при таймауте
  // «Read timeout expired» перестаёт слать апдейты (копит pending_update_count).
  // Фоновый канал-очередь выполняет апдейты строго по одному, чтобы не было гонок.
  enqueueUpdate(update);
  sendJson(res, 200, { ok: true });
}

// Очередь обработки апдейтов: строго последовательно, в фоне, не блокируя вебхук.
let updateQueue = Promise.resolve();
function enqueueUpdate(update) {
  updateQueue = updateQueue
    .then(() => dispatchUpdate(update))
    .catch((err) => console.error('webhook handler error:', err && err.message || err));
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

// GET /api/event-cities?url=<eventUrl> — список городов события «афиши».
// Используется мини-приложением (GitHub Pages) для выбора города слежения.
// Валидируем хост URL (защита от SSRF) и отдаём заголовки CORS для браузера.
function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

async function handleEventCities(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'bad_url' });
  }
  // Whitelist хостов: только 24afisha.by и bycard.by.
  const host = parsed.hostname.toLowerCase();
  if (!AFISHA_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'host_not_allowed' });
  }
  try {
    const data = await fetchEventCities(parsed.toString());
    if (!data) {
      return sendHeaders(res, corsHeaders(req), 404, { ok: false, error: 'not_found' });
    }
    const current = { slug: data.current.slug, label: cityLabel(data.current.slug), url: data.current.url };
    const cities = data.cities.map((c) => ({ slug: c.slug, label: cityLabel(c.slug), url: c.url }));
    sendHeaders(res, corsHeaders(req), 200, { ok: true, current, cities });
  } catch (err) {
    console.error('event-cities error:', err && err.message || err);
    sendHeaders(res, corsHeaders(req), 500, { ok: false, error: 'server_error' });
  }
}

// GET /api/ticketpro-search?q=<word> — живой поиск Ticketpro для Mini App:
// события (страница расширенного поиска) + площадки (кэш списка площадок).
async function handleTicketproSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (!q) return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'bad_query' });
  try {
    const [searchEvents, venues] = await Promise.all([
      searchTicketpro(q),
      searchTicketproVenues(q),
    ]);
    // Категория (кино/театр/концерт/…) в карточках Ticketpro не выводится — её
    // читаем из хлебных крошек страницы события (как тип у bycard).
    const events = await enrichTicketproCategories(searchEvents);
    sendHeaders(res, corsHeaders(req), 200, {
      ok: true,
      events: events.slice(0, 20).map((e) => ({
        uid: e.uid, title: e.title, url: e.url, image: e.image,
        category: e.category || null,
        city: e.city, venue: e.venue, dateText: e.dateText,
        priceFrom: e.priceFrom, priceTo: e.priceTo, currency: e.currency,
        onSale: e.onSale, status: e.status,
      })),
      venues: venues.slice(0, 10).map((v) => ({
        name: v.name, city: v.city, url: v.url, image: v.image,
      })),
    });
  } catch (err) {
    console.error('ticketpro-search error:', err && err.message || err);
    sendHeaders(res, corsHeaders(req), 500, { ok: false, error: 'server_error' });
  }
}

// GET /api/bezkassira-search?q=<word> — живой поиск BezKassira для Mini App.
async function handleBezkassiraSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (!q) return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'bad_query' });
  try {
    const found = await searchBezkassira(q);
    // Тип (кино/театр/концерт/…) в выдаче BezKassira не выводится и в URL события
    // не зашит — читаем его из хлебных крошек страницы события (как тип у bycard).
    const events = await enrichBezkassiraCategories(found);
    sendHeaders(res, corsHeaders(req), 200, {
      ok: true,
      events: events.slice(0, 20).map((e) => ({
        uid: e.uid, title: e.title, url: e.url, image: e.image,
        category: e.category || null,
        venue: e.venue, city: e.city,
      })),
    });
  } catch (err) {
    console.error('bezkassira-search error:', err && err.message || err);
    sendHeaders(res, corsHeaders(req), 500, { ok: false, error: 'server_error' });
  }
}

// GET /api/bezkassira-organizer?url=<eventUrl> — организатор события (для
// отслеживания «площадки»). Валидируем хост (SSRF-защита).
async function handleBezkassiraOrganizer(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'bad_url' });
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'bezkassira.by' && !host.endsWith('.bezkassira.by')) {
    return sendHeaders(res, corsHeaders(req), 400, { ok: false, error: 'host_not_allowed' });
  }
  try {
    const organizer = await fetchBezkassiraOrganizer(parsed.toString());
    if (!organizer) return sendHeaders(res, corsHeaders(req), 404, { ok: false, error: 'not_found' });
    sendHeaders(res, corsHeaders(req), 200, { ok: true, organizer });
  } catch (err) {
    console.error('bezkassira-organizer error:', err && err.message || err);
    sendHeaders(res, corsHeaders(req), 500, { ok: false, error: 'server_error' });
  }
}

function sendHeaders(res, headers, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
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
    if (url.pathname === '/api/event-cities') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        return await handleEventCities(req, res, url);
      }
    }
    if (url.pathname === '/api/ticketpro-search') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        return await handleTicketproSearch(req, res, url);
      }
    }
    if (url.pathname === '/api/bezkassira-search') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        return await handleBezkassiraSearch(req, res, url);
      }
    }
    if (url.pathname === '/api/bezkassira-organizer') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        return await handleBezkassiraOrganizer(req, res, url);
      }
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
