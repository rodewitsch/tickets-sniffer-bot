// Тесты AI-разбора статистики (lib/ai-report.js).
//
// Главное, что проверяем — контракт «ничего не ломаем»:
//   • без ключа функция выключена и не делает сетевых запросов;
//   • любая ошибка API превращается в null, а не в исключение;
//   • промпт содержит данные снимка и ключевые слова, по которым модель
//     поймёт задачу.
//
// Запуск: node scripts/test-ai-report.mjs

let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// env.js читает process.env на импорте, поэтому ключ нужно выставить ДО импорта.
// Проверяем оба режима в отдельных процессах, чтобы не кэшировать модуль.

const mode = process.argv[2];

async function runDisabled() {
  console.log('без ключа:');
  const mod = await import('../lib/ai-report.js');
  check('aiReportEnabled() === false', mod.aiReportEnabled() === false);

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('fetch не должен вызываться без ключа');
  };
  const res = await mod.requestAiReport({ today: {} });
  check('requestAiReport → null', res === null);
  check('сеть не тронута', called === false);
  check('buildPrompt без снимка не падает', mod.buildPrompt({}) === null || typeof mod.buildPrompt({}) === 'string');
}

async function runEnabled() {
  console.log('с ключом:');

  // env.js читает process.env на импорте. Если ключ забыли выставить, падаем
  // сразу с понятным сообщением, а не TypeError на null ниже.
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('  SKIP  DEEPSEEK_API_KEY не задан — запустите с ключом:');
    console.log('        $env:DEEPSEEK_API_KEY="sk-test"; node scripts/test-ai-report.mjs enabled');
    process.exit(1);
  }

  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '🔴 Площадка x падает.\n✅ Остальное в норме.' } }], usage: { total_tokens: 123 } }),
      text: async () => '',
    };
  };

  const mod = await import('../lib/ai-report.js');
  check('aiReportEnabled() === true', mod.aiReportEnabled() === true);

  const snapshot = {
    today: { cycles: 24, failed: 1, budgetPct: 87 },
    venues: { queued: 12, failing: 2, failingUrls: 1, failingList: [{ url: 'https://bycard.by/afisha/minsk/venues/dtu', rows: 2, dueInMin: 30 }] },
    trend: [{ date: '2025-01-01', cycles: 24 }],
  };
  const text = await mod.requestAiReport(snapshot);
  check('вернулся текст', typeof text === 'string' && text.length > 0);
  check('без markdown-обёртки', !text.startsWith('```'));

  check('сделан один запрос', captured.length === 1);
  const req = captured[0] || {};
  check('POST на /chat/completions', String(req.url).endsWith('/chat/completions'), req.url);
  check('Bearer-авторизация', /^Bearer .+/.test(req.init?.headers?.authorization || ''));
  const body = JSON.parse(req.init?.body || '{}');
  check('модель указана', !!body.model, body.model);
  check('temperature низкая', body.temperature === 0.3);
  check('есть system и user', body.messages?.length === 2);
  const userText = body.messages?.[1]?.content || '';
  check('в промпт попал снимок', userText.includes('"failingUrls": 1'));
  check('в промпте слово venue', userText.includes('venue'));
  check('система упоминает бюджет', /budgetPct/.test(body.messages?.[0]?.content || ''));
  check('система объясняет failing vs failingUrls', /failingUrls/.test(body.messages?.[0]?.content || ''));

  // Ошибка HTTP → null, без исключения.
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limit' });
  const on429 = await mod.requestAiReport(snapshot);
  check('HTTP 429 → null', on429 === null);

  // Сетевая ошибка → null.
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const onErr = await mod.requestAiReport(snapshot);
  check('сетевая ошибка → null', onErr === null);

  // Пустой ответ модели → null, а не пустое сообщение.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }) });
  const onEmpty = await mod.requestAiReport(snapshot);
  check('пустой ответ → null', onEmpty === null);

  // Слишком длинный ответ обрезается.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'строка\n'.repeat(500) } }] }),
  });
  const long = await mod.requestAiReport(snapshot);
  check('длинный ответ обрезан', typeof long === 'string' && long.length <= 1501, String(long).length);
}

if (mode === 'enabled') {
  await runEnabled();
} else {
  await runDisabled();
}

if (failures) {
  console.log(`\n${failures} проверок провалено`);
  process.exit(1);
}
console.log('\nвсе проверки пройдены');
