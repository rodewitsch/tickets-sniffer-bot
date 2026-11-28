// Парсер BezKassira как DO Function. Один вход — один ответ, без состояния.
//
// Логика берётся из lib/sources/bezkassira.js (см. lib/build.cmd). Модули
// проекта — ESM, точка входа — CommonJS, поэтому подключение через `import()`.
//
// Контракт: GET ?action=<name>&...
//   search      ?query=<текст>        → [карточки]
//   details     ?url=<url события>    → карточка | null
//   organizer   ?url=<url организатора> → [ссылки]

let modPromise = null;
function loadParser() {
  if (!modPromise) modPromise = import('./lib/sources/bezkassira.js');
  return modPromise;
}

async function main(args) {
  const p = args || {};
  const q = p.__ow_query ? Object.fromEntries(new URLSearchParams(p.__ow_query)) : {};
  const get = (k) => p[k] ?? q[k];

  const action = get('action');
  try {
    const lib = await loadParser();

    if (action === 'search') {
      const query = get('query');
      if (!query) return { statusCode: 400, body: { ok: false, error: 'query is required' } };
      return { body: { ok: true, result: await lib.searchBezkassira(query) } };
    }

    if (action === 'details') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchBezkassiraEventDetails(url) } };
    }

    if (action === 'organizer') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchBezkassiraOrganizerEventLinks(url) } };
    }

    return { statusCode: 400, body: { ok: false, error: `unknown action: ${action}` } };
  } catch (e) {
    return { statusCode: 502, body: { ok: false, error: (e && e.message) || String(e) } };
  }
}

exports.main = main;
