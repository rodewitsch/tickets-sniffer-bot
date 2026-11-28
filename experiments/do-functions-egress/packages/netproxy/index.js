// Функция-прокси для сайтов, блокирующих IP Droplet.
//
// Зачем: bycard.by / 24afisha.by / api.24afisha.by не отвечают на TCP:443 с
// Droplet (178.172.160.176), но доступны из DO Functions (egress
// 207.154.197.204, замер: docs/do-functions-egress.md). Bot вызывает эту
// функцию, она делает fetch от своего имени и возвращает тело как есть.
//
// Контракт:   GET ?url=<https://...>
// Ответ:      { status, body, finalUrl }  (body — строка, как res.text())
// Ошибка:     400 — нет/невалидный url, 403 — хост не в белом списке.
//
// БЕЗОПАСНОСТЬ — это открытый прокси, поэтому:
//   • WHITELIST проверяется ЗДЕСЬ, а не только в боте (иначе через функцию
//     можно ходить на что угодно от нашего имени);
//   • только https и только эти хосты;
//   • держать функцию с webSecure (X-Require-Whisk-Auth), значение — в env
//     бота (FETCH_PROXY_SECRET), иначе ей сможет пользоваться кто угодно.
//
// ГРАБЛИ рантайма (см. docs/do-functions-egress.md): форма модуля — CommonJS
// (`exports.main`), в project.yml НЕЛЬЗЯ указывать `main:`, имя функции должно
// совпадать с именем файла (index.js → functions.name: index).

const WHITELIST = ['bycard.by', '24afisha.by'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return WHITELIST.some((h) => host === h || host.endsWith('.' + h));
}

// Сайт отдаёт антибот-заглушку «Verification» с cookie hg-security вместо
// страницы. Тот же обход уже есть в боте (lib/http.js): вытащить токен из
// скрипта-челленджа и повторить запрос с Cookie. Без этого прокси возвращал
// 200 и 1.2 КБ заглушки — снаружи выглядело как «страница есть», а данных нет.
function isChallenge(html) {
  return html && html.length < 5000 && html.includes('hg-security');
}

function extractChallengeToken(html) {
  const m = html.match(/hg-security=([A-Za-z0-9_\-=.]+)/);
  return m ? m[1] : null;
}

async function fetchFollow(target, timeoutMs) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru,en;q=0.8',
  };
  let res = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  let body = await res.text();
  if (isChallenge(body)) {
    const token = extractChallengeToken(body);
    if (token) {
      res = await fetch(target, {
        headers: { ...headers, Cookie: `hg-security=${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      body = await res.text();
    }
  }
  return { res, body };
}

async function main(args) {
  // `url` может прийти и из query, и из тела (json), и как raw.
  const raw = (args && (args.url || (args.__ow_query && args.__ow_query.url))) || '';
  // Если query пришёл строкой 'url=...', разберём.
  let input = String(raw || '');
  if (!input && args && typeof args.__ow_query === 'string') {
    const m = /(?:^|&)url=([^&]+)/.exec(args.__ow_query);
    if (m) input = decodeURIComponent(m[1]);
  }
  if (!input) return { statusCode: 400, body: { error: 'url is required' } };

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { statusCode: 400, body: { error: 'invalid url' } };
  }
  if (parsed.protocol !== 'https:') {
    return { statusCode: 400, body: { error: 'only https is allowed' } };
  }
  if (!hostAllowed(parsed.hostname)) {
    return { statusCode: 403, body: { error: `host not allowed: ${parsed.hostname}` } };
  }

  const started = Date.now();
  try {
    const { res, body } = await fetchFollow(parsed.toString(), 8000);
    return {
      body: {
        status: res.status,
        finalUrl: res.url,
        tookMs: Date.now() - started,
        body,
      },
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: { error: 'upstream failed', detail: (e && (e.name || e.message)) || 'error' },
    };
  }
}

exports.main = main;
