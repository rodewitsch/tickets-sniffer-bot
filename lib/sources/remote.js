// Маршрутизация парсинга: локально или через DO Functions.
//
// Зачем: сайты bycard.by / 24afisha.by блокируют IP Droplet, и часть парсеров
// логично выполнять в Functions (там другой egress). Но перенос не должен быть
// «всё или ничего»: если функция недоступна или env не задан, бот продолжает
// работать локально, как раньше.
//
// Как включить: задать в env URL функции-парсера
//   PARSER_URL_AFISHA=https://faas-…/parser/afisha
//   PARSER_URL_TICKETPRO=…
//   PARSER_URL_BEZKASSIRA=…
// Пустое значение = выключено для этого источника (поведение как до выноса).
//
// Зачем отдельный модуль, а не правки в каждом парсере: у источников одинаковый
// контракт (search/details/…), и вызывающему коду (checker.js) должно быть
// неважно, где выполняется парсинг. Здесь это решается в ОДНОМ месте.
//
// ГРАБЛИ: модули проекта — ESM, а DO Functions возвращает JSON-обёртку
// { ok, result }. Ошибку функции (ok:false) превращаем в исключение: иначе
// пустой ответ выглядел бы как «событий нет».

const DEFAULT_TIMEOUT_MS = 20000;

function envKey(source) {
  return `PARSER_URL_${String(source || '').toUpperCase()}`;
}

/** Настроен ли удалённый парсер для источника. */
export function parserRemoteUrl(source) {
  return String(process.env[envKey(source)] || '').trim().replace(/\/+$/, '');
}

/**
 * Вызов функции-парсера.
 * @param {string} source  'afisha' | 'ticketpro' | 'bezkassira'
 * @param {string} action  'search' | 'details' | 'availability' | 'venue' | …
 * @param {object} params  параметры (query, url, city, …)
 * @returns {Promise<any>} поле result из ответа функции
 */
export async function callParser(source, action, params = {}) {
  const base = parserRemoteUrl(source);
  if (!base) throw new Error(`remote parser not configured for ${source}`);

  const qs = new URLSearchParams({ action, ...params });
  const res = await fetch(`${base}?${qs.toString()}`, {
    headers: {
      ...(process.env.PARSER_SECRET ? { 'X-Require-Whisk-Auth': process.env.PARSER_SECRET } : {}),
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* не JSON — ниже отдадим ошибку */ }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`parser ${source}/${action}: non-JSON response (${res.status})`);
  }
  if (!payload.ok) {
    throw new Error(`parser ${source}/${action}: ${payload.error || 'unknown error'}`);
  }
  return payload.result;
}

/**
 * Обёртка «удалённо, если настроено, иначе локально».
 * Локальная реализация вызывается только когда функции нет в env.
 *
 * @param {string} source
 * @param {string} action
 * @param {object} params  аргументы для функции
 * @param {() => Promise<any>} local  локальный парсер (тот же результат)
 */
export async function parserOrLocal(source, action, params, local) {
  if (!parserRemoteUrl(source)) return local();
  return callParser(source, action, params);
}
