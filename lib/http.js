// HTTP-обёртка над sdk/fetch: браузерный UA, таймауты, обход антибот-челленджа
// «hg-security» (24afisha.by / bycard.by выдают его подозрительным клиентам).
import { FETCH_TIMEOUT_MS } from './config.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('fetch timeout')), ms)),
  ]);
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

  let res = await withTimeout(fetch(url, { headers: baseHeaders }), timeout);
  let text = await withTimeout(res.text(), timeout);

  if (isChallenge(text)) {
    const token = extractChallengeToken(text);
    if (token) {
      res = await withTimeout(
        fetch(url, { headers: { ...baseHeaders, Cookie: `hg-security=${token}` } }),
        timeout,
      );
      text = await withTimeout(res.text(), timeout);
    }
  }

  return { status: res.status, ok: res.ok, text, finalUrl: res.url, headers: res.headers };
}

export async function httpJson(url, { headers = {}, timeout = FETCH_TIMEOUT_MS } = {}) {
  const res = await withTimeout(
    fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ru,en;q=0.8', ...headers },
    }),
    timeout,
  );
  const text = await withTimeout(res.text(), timeout);
  let data = null;
  try { data = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}
