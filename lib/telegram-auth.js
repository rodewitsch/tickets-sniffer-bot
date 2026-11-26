// Проверка подлинности запросов Telegram.
//
// Две независимые вещи:
//
// 1. Webhook-секрет. При setWebhook Telegram присылает секрет в заголовке
//    X-Telegram-Bot-Api-Secret-Token. Без проверки эндпоинт /webhook публичен:
//    зная домен, любой может прислать поддельный Update с произвольным
//    message.chat.id и менять чужие подписки. Сравнение — constant-time.
//
// 2. Подпись Mini App (initData). Telegram подписывает строку initData HMAC-SHA256
//    с ключом, производным от токена бота. Проверка нужна, только если её
//    действительно можно выполнить: в сценарии web_app_data бот получает данные
//    от Telegram уже проверенными (см. lib/webapp.js), и подписи там нет.
import crypto from 'node:crypto';

/**
 * Constant-time сравнение секрета из заголовка с ожидаемым.
 * Возвращает false, если ожидаемый секрет не задан (тогда проверка выключена
 * в другую сторону: см. server.js — вебхук без секрета не принимается вовсе).
 */
export function webhookSecretMatches(received, expected) {
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(String(expected));
  // timingSafeEqual бросает при разной длине — длину секрета не скрываем.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Проверка initData из Telegram Mini App.
 *
 * ВНИМАНИЕ: сейчас НЕ используется. Бот получает данные только через
 * message.web_app_data — их доставляет сам Telegram (подделать можно лишь
 * подделав апдейт, а это закрывает секрет вебхука). Хелпер оставлен на случай
 * настоящего Mini App с прямыми запросами на сервер: тогда initData нужно
 * проверять ЗДЕСЬ, а не доверять chatId из апдейта.
 *
 * Формат: `<key>=<value>&…&hash=<hex>`; подписывается data_check_string —
 * все пары, кроме hash, отсортированные по ключу и склеенные '\n'.
 *
 * Возвращает распарсенные поля (user — уже объект) при успехе, иначе null.
 * `maxAgeSec` отсекает старые подписи (защита от повторного использования);
 * если auth_date нет вовсе — подпись не принимается.
 */
export function verifyInitData(initData, botToken, { maxAgeSec = 24 * 60 * 60, nowMs = Date.now() } = {}) {
  if (!initData || !botToken) return null;
  let params;
  try {
    params = new URLSearchParams(String(initData));
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const given = String(hash).toLowerCase();
  if (computed.length !== given.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(given))) return null;

  const authDate = Number(params.get('auth_date')) || 0;
  // Без auth_date подпись можно переиспользовать вечно — не принимаем.
  if (!authDate) return null;
  // Допускаем небольшой рассинхрон часов и отсекаем «будущее» (перекошенный
  // auth_date тоже не повод пропускать подпись).
  const nowSec = nowMs / 1000;
  if (authDate > nowSec + 300) return null;
  if (nowSec - authDate > maxAgeSec) return null;

  const out = Object.fromEntries(params.entries());
  if (out.user) {
    try { out.user = JSON.parse(out.user); } catch { /* оставляем строкой */ }
  }
  return out;
}
