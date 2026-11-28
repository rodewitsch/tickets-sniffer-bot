// Парсер «афиши» как DO Function. Один вход — один ответ, никакого состояния.
//
// Зачем вынесен: сайты bycard.by / 24afisha.by блокируют IP Droplet, а из
// Functions доступны (замер: docs/do-functions-egress.md). Логика парсинга —
// та же, что в lib/sources/afisha.js; файлы кладутся в пакет через lib/build.sh
// и .include, поэтому копии кода в git нет.
//
// ВАЖНО про модульную систему: модули проекта — ESM (`export function …`), а
// рантайм DO Functions грузит точку входа как CommonJS. `require()` ESM падает
// с ERR_REQUIRE_ESM, поэтому модуль подключается ДИНАМИЧЕСКИМ `import()` (он
// работает и из CJS), а `main` сделан async.
//
// Контракт: GET ?action=<name>&...
//   search       ?query=<текст>              → { events, venues }
//   details      ?url=<url события>          → карточка | null
//   availability ?url=<url>&city=<slug|all>  → { onSale, event, citySlug }
//   venue        ?url=<url площадки>         → { venue, events }
//
// Ответ всегда JSON: { ok, result } или { ok:false, error }.

// Кэш импорта: один инстанс модуля на тёплый контейнер.
let modPromise = null;
function loadParser() {
  if (!modPromise) modPromise = import('./lib/sources/afisha.js');
  return modPromise;
}

async function main(args) {
  const p = args || {};
  // Параметры приходят и из query, и из тела — нормализуем.
  const q = p.__ow_query ? Object.fromEntries(new URLSearchParams(p.__ow_query)) : {};
  const get = (k) => p[k] ?? q[k];

  const action = get('action');
  try {
    const lib = await loadParser();

    if (action === 'search') {
      const query = get('query');
      if (!query) return { statusCode: 400, body: { ok: false, error: 'query is required' } };
      return { body: { ok: true, result: await lib.searchAfisha(query) } };
    }

    if (action === 'details') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchAfishaEventDetails(url) } };
    }

    if (action === 'availability') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      const city = get('city') || null;
      return { body: { ok: true, result: await lib.fetchAfishaCityAvailability(url, city) } };
    }

    if (action === 'venue') {
      const url = get('url');
      if (!url) return { statusCode: 400, body: { ok: false, error: 'url is required' } };
      return { body: { ok: true, result: await lib.fetchAfishaVenueEvents(url) } };
    }

    return { statusCode: 400, body: { ok: false, error: `unknown action: ${action}` } };
  } catch (e) {
    // Парсер — не точка отказа бота: возвращаем ошибку данными, а не 500.
    return { statusCode: 502, body: { ok: false, error: (e && e.message) || String(e) } };
  }
}

exports.main = main;
