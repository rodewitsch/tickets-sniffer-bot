// Парсер Ticketpro как DO Function. Один вход — один ответ, без состояния.
//
// Логика берётся из lib/sources/ticketpro.js (см. lib/build.cmd: модули
// копируются в пакет при сборке, копии кода в git нет).
//
// Модули проекта — ESM, а точка входа грузится как CommonJS, поэтому
// подключение идёт через `import()` (см. комментарий в parser/afisha).
//
// Контракт: GET ?action=<name>&...
//   search      ?query=<текст>        → [карточки]
//   details     ?url=<url события>    → карточка | null
//   venueLinks  ?url=<url площадки>   → [ссылки на события площадки]
//   venues      ?query=<текст>        → [площадки]

let modPromise = null;
function loadParser() {
  if (!modPromise) modPromise = import('./lib/sources/ticketpro.js');
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
      return { body: { ok: true, result: await lib.searchTicketpro(query) } };
    }

    if (action === 'details') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchTicketproEventDetails(url) } };
    }

    if (action === 'venueLinks') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchTicketproVenueEventLinks(url) } };
    }

    if (action === 'venues') {
      const query = get('query');
      if (!query) return { statusCode: 400, body: { ok: false, error: 'query is required' } };
      return { body: { ok: true, result: await lib.searchTicketproVenues(query) } };
    }

    return { statusCode: 400, body: { ok: false, error: `unknown action: ${action}` } };
  } catch (e) {
    return { statusCode: 502, body: { ok: false, error: (e && e.message) || String(e) } };
  }
}

exports.main = main;
