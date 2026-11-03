// Реальный слой sdk/api для DigitalOcean Droplet: вызовы Telegram Bot API
// через глобальный fetch. Аналог `api.<method>(params)` платформы Telegram:
// возвращает unwrapped result и бросает BotApiError при неудаче.
import { BOT_TOKEN, API_HOST } from './env.js';

// Таймаут одного вызова Bot API. Отправка уведомления — не критичный по времени
// шаг, но БЕЗ таймаута зависшее TCP-соединение останавливало цикл проверки:
// fetch в Node не имеет собственного таймаута и ждёт ответа бесконечно.
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 15000);
// Пауза перед повторной попыткой сетевого сбоя («fetch failed» / HTTP 5xx).
// Достаточно, чтобы короткий обрыв до api.telegram.org рассосался; для проверок
// это максимум +30 с (две попытки по таймауту), что терпимо раз в сбой.
const API_RETRY_DELAY_MS = Number(process.env.API_RETRY_DELAY_MS || 30000);

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

// Повторная отправка при СЕТЕВЫХ сбоях: один раз, и только когда ответа не было
// вовсе («fetch failed», статус 0) либо Telegram ответил 5xx/429. Ошибки уровня
// приложения (400, 403, 409 и т.п.) ретраить бессмысленно — их возвращаем сразу.
// Раньше одиночный «fetch failed» ронял ежедневную статистику и оставлял её
// вообще без отправки (и без AI-разбора следом).
function isRetryable(code) {
  return code === 0 || code === 429 || (code >= 500 && code <= 599);
}

async function call(method, params) {
  if (!BOT_TOKEN) {
    throw new BotApiError(500, 'BOT_TOKEN is not set', method, null);
  }
  const url = `https://${API_HOST}/bot${BOT_TOKEN}/${method}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
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
      const netErr = new BotApiError(0, String(err && err.message ? err.message : err), method, null);
      if (attempt === 1) {
        console.warn(`[api] ${method}: сетевой сбой, повтор через ${API_RETRY_DELAY_MS / 1000}с (${netErr.message})`);
        await new Promise((r) => setTimeout(r, API_RETRY_DELAY_MS));
        continue;
      }
      throw netErr;
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
      const errParams = (body && body.parameters) || null;
      if (attempt === 1 && isRetryable(code)) {
        console.warn(`[api] ${method}: HTTP ${code}, повтор через ${API_RETRY_DELAY_MS / 1000}с`);
        await new Promise((r) => setTimeout(r, API_RETRY_DELAY_MS));
        continue;
      }
      throw new BotApiError(code, desc, method, errParams);
    }
    return body.result;
  }
}

// Proxy-объект: любой метод api.<method>(params) диспатчится на Bot API.
export const api = new Proxy({}, {
  get: (_t, prop) => {
    if (typeof prop !== 'string') return undefined;
    return (params) => call(prop, params);
  },
});
