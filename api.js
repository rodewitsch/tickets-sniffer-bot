// Реальный слой sdk/api для DigitalOcean Droplet: вызовы Telegram Bot API
// через глобальный fetch. Аналог `api.<method>(params)` платформы Telegram:
// возвращает unwrapped result и бросает BotApiError при неудаче.
import { BOT_TOKEN, API_HOST } from './env.js';

// Таймаут одного вызова Bot API. Отправка уведомления — не критичный по времени
// шаг, но БЕЗ таймаута зависшее TCP-соединение останавливало цикл проверки:
// fetch в Node не имеет собственного таймаута и ждёт ответа бесконечно.
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 15000);

export class BotApiError extends Error {
  constructor(code, description, method, parameters) {
    super(`${method}: ${description} (${code})`);
    this.name = 'BotApiError';
    this.code = code;
    this.description = description;
    this.method = method;
    this.parameters = parameters || null;
  }
}

async function call(method, params) {
  if (!BOT_TOKEN) {
    throw new BotApiError(500, 'BOT_TOKEN is not set', method, null);
  }
  const url = `https://${API_HOST}/bot${BOT_TOKEN}/${method}`;
  let res;
  try {
    // Таймаут обязателен: без него зависший запрос к Telegram останавливал весь
    // цикл проверки НАВСЕГДА (в проде так висело по 5+ минут: цикл успевал
    // обойти позиции, а затем застревал на отправке уведомления). AbortSignal
    // рвёт соединение, ошибка уходит в обычный catch ниже.
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BotApiError(0, String(err && err.message ? err.message : err), method, null);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new BotApiError(res.status, 'Non-JSON response from Bot API', method, null);
  }

  if (!body || body.ok !== true) {
    const code = body && typeof body.error_code === 'number' ? body.error_code : res.status;
    const desc = (body && body.description) || `HTTP ${res.status}`;
    const params = (body && body.parameters) || null;
    throw new BotApiError(code, desc, method, params);
  }
  return body.result;
}

// Proxy-объект: любой метод api.<method>(params) диспатчится на Bot API.
export const api = new Proxy({}, {
  get: (_t, prop) => {
    if (typeof prop !== 'string') return undefined;
    return (params) => call(prop, params);
  },
});
