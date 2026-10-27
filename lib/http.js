// HTTP-обёртка над sdk/fetch: браузерный UA, таймауты, обход антибот-челленджа
// «hg-security» (24afisha.by / bycard.by выдают его подозрительным клиентам).
import { FETCH_TIMEOUT_MS } from './config.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Таймаут через AbortSignal, а не Promise.race.
//
// Promise.race с setTimeout имел две проблемы:
//   1. таймер НЕ очищался — каждый успешный запрос держал живой таймер до 9 с
//      (при обходе площадок это сотни лишних таймеров в цикле);
//   2. по истечении таймаута сам запрос НЕ прерывался: соединение и загрузка
//      тела продолжались, то есть «таймаут» только возвращал управление, а
//      нагрузка на сайт оставалась. Ровно эту же ошибку когда-то исправляли в
//      api.js через AbortSignal.timeout.
function timeoutSignal(ms) {
  return AbortSignal.timeout(Math.max(1, Number(ms) || FETCH_TIMEOUT_MS));
}

function isChallenge(html) {
  return html && html.length < 5000 && html.includes('hg-security');
}

function extractChallengeToken(html) {
  const m = html.match(/hg-security=([A-Za-z0-9_\-=.]+)/);
  return m ? m[1] : null;
}

export async function httpGet(url, { headers = {}, timeout = FETCH_TIMEOUT_MS } = {}) {
  const baseHeaders = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru,en;q=0.8',
    ...headers,
  };

  let res = await fetch(url, { headers: baseHeaders, signal: timeoutSignal(timeout) });
  let text = await res.text();

  if (isChallenge(text)) {
    const token = extractChallengeToken(text);
    if (token) {
      res = await fetch(url, {
        headers: { ...baseHeaders, Cookie: `hg-security=${token}` },
        signal: timeoutSignal(timeout),
      });
      text = await res.text();
    }
  }

  return { status: res.status, ok: res.ok, text, finalUrl: res.url, headers: res.headers };
}

export async function httpJson(url, { headers = {}, timeout = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ru,en;q=0.8', ...headers },
    signal: timeoutSignal(timeout),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}
