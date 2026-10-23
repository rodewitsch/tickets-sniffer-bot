// Локальный smoke-тест слоя БД (Drizzle + better-sqlite3) и чистых хелперов
// рендера списка (эмодзи/ссылки). Запуск: node smoke.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изоляция БД: тест НИКОГДА не должен трогать рабочий data/bot.db. Если DB_PATH
// не задан снаружи — подставляем временный файл и удаляем его в конце.
const ownDb = !process.env.DB_PATH;
const tempDb = ownDb
  ? path.join(os.tmpdir(), `smoke-${process.pid}-${Date.now()}.db`)
  : process.env.DB_PATH;
process.env.DB_PATH = tempDb;

const { count } = await import('drizzle-orm');
const { default: db, sqlite, eq, and, desc } = await import('./db.js');
const { users, events, watchItems, checkLog } = await import('./schema.js');
const { runMigrations } = await import('./migrate.js');
const {
  renderWatchlist, itemEmoji, unsubDeepLink, unsubConfirmText, unsubConfirmKeyboard,
} = await import('./lib/menus.js');
const { venueCityFromSlug, citySlugFrom, cityLabel } = await import('./lib/cities.js');
const { matchesQueryTokens, translitRu } = await import('./lib/util.js');
const { reportPeriodEndSec, msUntilNextMinsk, formatReport } = await import('./lib/stats.js');
const { record, resetBudgetStats, snapshotBudgetStats } = await import('./lib/budget.js');

function cleanup() {
  if (!ownDb) return;
  // better-sqlite3 держит файл открытым до close(): без этого rmSync на Windows
  // молча падает с EBUSY и временные БД копятся в %TEMP%.
  try { sqlite.close(); } catch { /* уже закрыта */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(tempDb + suffix, { force: true });
    } catch { /* не критично для результата теста */ }
  }
  if (fs.existsSync(tempDb)) {
    console.warn(`⚠ временная БД не удалена (файл занят): ${tempDb}`);
  }
}

async function main() {
  // Регрессия прода: cron пишет в check_log, но миграции применял только
  // server.js. Вставка в «старую» схему падала молча (ошибка шла в лог), и циклы
  // сутками не логировались. Теперь миграции запускает и cron.js, а вызов должен
  // быть идемпотентным — контейнеры стартуют независимо и оба его делают.
  runMigrations();
  runMigrations();

  // Схема после миграций содержит все колонки, которые пишет чекер (cron).
  const cols = sqlite.prepare('PRAGMA table_info(check_log)').all().map((c) => c.name);
  for (const col of [
    'city_checks', 'city_probes_max', 'venue_quota_hit',
    'venue_crawl_time_truncated', 'venue_crawl_budget_truncated', 'venue_crawl_deferred',
  ]) {
    assert.ok(cols.includes(col), `check_log has ${col} after migrations`);
  }

  // users: insert + onConflictDoUpdate
  await db.insert(users).values({ chatId: 1, username: 'a', firstName: 'A' })
    .onConflictDoUpdate({ target: users.chatId, set: { lastSeenAt: 111 } }).run();
  let u = await db.select().from(users).where(eq(users.chatId, 1)).get();
  assert.equal(u.username, 'a', 'insert worked');

  await db.insert(users).values({ chatId: 1 })
    .onConflictDoUpdate({ target: users.chatId, set: { lastSeenAt: 222 } }).run();
  u = await db.select().from(users).where(eq(users.chatId, 1)).get();
  assert.equal(u.lastSeenAt >= 111, true, 'conflict update ran');

  // events: insert + returning + bool mode + filter + count
  const [ev] = await db.insert(events).values({
    source: 'afisha', uid: 'slug-1', title: 'Event One', url: 'https://e/1', onSale: true, status: 'onsale',
  }).returning();
  assert.equal(ev.uid, 'slug-1', 'returning uid');
  assert.equal(ev.onSale, true, 'bool read back');

  await db.insert(events).values({
    source: 'ticketpro', uid: 'tp-1', title: 'TP', url: 'https://t/1', onSale: false, status: 'nosale',
  }).returning();

  const onsale = await db.select().from(events).where(and(eq(events.source, 'afisha'), eq(events.onSale, true))).all();
  assert.equal(onsale.length, 1, 'filtered select');
  assert.equal(onsale[0].title, 'Event One');
  const cnt = await db.select({ n: count() }).from(events).where(eq(events.source, 'afisha'));
  assert.equal(cnt[0]?.n, 1, 'count');

  // watchItems: orderBy desc created_at + update/delete
  const [w1] = await db.insert(watchItems).values({ chatId: 1, kind: 'query', source: 'all', query: 'гагарина' }).returning();
  const [w2] = await db.insert(watchItems).values({ chatId: 1, kind: 'event', source: 'afisha', query: 'event' }).returning();
  const list = await db.select().from(watchItems).where(eq(watchItems.chatId, 1)).orderBy(desc(watchItems.createdAt)).all();
  assert.equal(list.length, 2, 'two watch items');

  // city column: insert + read-back
  const [w3] = await db.insert(watchItems).values({ chatId: 2, kind: 'event', source: 'afisha', query: 'nakrayu', city: 'brest' }).returning();
  assert.equal(w3.city, 'brest', 'city read back');
  const w3row = await db.select().from(watchItems).where(eq(watchItems.id, w3.id)).get();
  assert.equal(w3row.city, 'brest', 'city persisted');

  await db.update(watchItems).set({ active: false }).where(eq(watchItems.id, w1.id)).run();
  const active = await db.select().from(watchItems).where(and(eq(watchItems.chatId, 1), eq(watchItems.active, true))).all();
  assert.equal(active.length, 1, 'deactivated one');
  await db.delete(watchItems).where(eq(watchItems.id, w2.id)).run();
  await db.delete(watchItems).where(eq(watchItems.id, w3.id)).run();
  const afterDel = await db.select().from(watchItems).where(eq(watchItems.chatId, 1)).all();
  assert.equal(afterDel.length, 1, 'deleted one');

  // «Мой список»: эмодзи по типу/категории + ссылки-диплинки, без кнопок удаления.
  assert.equal(itemEmoji({ kind: 'query' }), '🔍', 'query emoji');
  assert.equal(itemEmoji({ kind: 'venue' }), '🏟', 'venue emoji');
  assert.equal(itemEmoji({ kind: 'event', category: 'Кино' }), '🎬', 'cinema emoji');
  assert.equal(itemEmoji({ kind: 'event', category: 'Концерты' }), '🎤', 'concert emoji');
  assert.equal(itemEmoji({ kind: 'event', category: 'Выставка' }), '🖼', 'exhibition emoji');
  assert.equal(itemEmoji({ kind: 'event', category: 'Нечто' }), '🎫', 'unknown category fallback');
  assert.equal(unsubDeepLink(7), 'https://t.me/tickets_sniffer_bot?start=unsub_7', 'deep link shape');

  const listText = renderWatchlist([
    { id: 1, kind: 'event', source: 'afisha', title: 'Идиоты & Ко', category: 'Театр', city: 'minsk', eventUrl: 'https://bycard.by/x?a=1&b=2' },
    { id: 2, kind: 'venue', source: 'ticketpro', title: 'Мир', city: 'brest', eventUrl: 'https://tp/1' },
    { id: 3, kind: 'query', source: 'all', query: 'спайдермен' },
  ]);
  assert.ok(listText.includes('📋 <b>Мой список</b> · 3 позиции'), 'header with plural');
  assert.ok(listText.includes('🎭 <b><a href="https://bycard.by/x?a=1&amp;b=2">Идиоты &amp; Ко</a></b>'), 'escaped clickable title');
  assert.ok(listText.includes('🏟 <b><a href="https://tp/1">Мир</a></b>'), 'venue title is a link');
  assert.ok(listText.includes('🔍 <b>спайдермен</b>'), 'query title is plain text');
  assert.ok(listText.includes('<a href="https://t.me/tickets_sniffer_bot?start=unsub_3">🔕 отписаться</a>'), 'per-item unsubscribe link');
  assert.ok(listText.includes('Театр · Афиша · 📍 Минск'), 'type/source/city meta');
  assert.ok(!listText.includes('❌'), 'no delete buttons in text');
  assert.ok(!listText.includes('callback'), 'no callback data leaked');
  // Ловим двойное экранирование переводов строки: в тексте не должно быть
  // литерала «обратный слэш + n» (строка собрана через String.fromCharCode(92),
  // чтобы проверка сама не зависела от экранирования в исходнике).
  assert.ok(!listText.includes(String.fromCharCode(92) + 'n'), 'no literal backslash-n in the rendered list');
  assert.ok(listText.endsWith('события или площадки.</i>'), 'footer is the last line');

  const emptyText = renderWatchlist([]);
  assert.ok(emptyText.includes('Список пуст') && emptyText.includes('Найти и следить'), 'empty list CTA');

  assert.ok(unsubConfirmText({ kind: 'event', source: 'afisha', category: 'Театр', title: 'Идиоты', city: 'minsk' }).includes('Отписаться?'), 'confirm text');
  const confirmKb = unsubConfirmKeyboard(5).inline_keyboard;
  assert.equal(confirmKb[0][0].callback_data, 'unsub:yes:5', 'confirm yes callback');
  assert.equal(confirmKb[1][0].callback_data, 'unsub:no:5', 'confirm no callback');

  // Поиск по площадкам: город из слага площадки + сверка имени запроса с именем
  // площадки (включая транслит «Бельведер» ↔ «Belvedere»).
  assert.equal(venueCityFromSlug('kinoteatr-mir-brest-brest'), 'brest', 'venue city from slug');
  assert.equal(venueCityFromSlug('158-respublikanskij-teatr-belorusskoj-dramaturgii'), '', 'venue city unknown → empty');
  // Город — последний сегмент слага. Хвост, лишь похожий на город, городом не считается:
  // «берёст» (береста) не должен превращаться в brest. Но реальные слаги афиши всегда
  // заканчиваются именно городом, поэтому позитив остаётся позитивом.
  assert.equal(venueCityFromSlug('teatr-ne-berest'), '', 'suffix that only looks like a city is rejected');
  assert.equal(venueCityFromSlug('dom-kultury-berestye'), '', 'no city suffix → empty');
  assert.equal(venueCityFromSlug('komediya-minsk'), 'minsk', 'city as last segment');
  assert.equal(venueCityFromSlug('4950-zasluzhennyj-kollektiv-minskiy-oblastnoy-teatr-kukol-batleyka-molodechno'), 'molodechno', 'long slug keeps its own city');
  assert.equal(matchesQueryTokens('РТБД', 'РТБД'), true, 'venue name exact token match');
  assert.equal(matchesQueryTokens('Бельведер', 'Belvedere'), true, 'venue name translit match');
  assert.equal(matchesQueryTokens('Театр кукол', 'Театр эстрады'), false, 'venue name false positive rejected');
  assert.equal(translitRu('Молодёжный театр'), 'molodezhnyi teatr', 'translit of venue name');

  // Нормализация города: метка/написание → слаг. Нужна, потому что источники
  // отдают город по-разному («Минск» у ticketpro/bezkassira, «minsk» у афиши).
  assert.equal(citySlugFrom('Минск'), 'minsk', 'city label normalized to slug');
  assert.equal(citySlugFrom('минск'), 'minsk', 'lowercase label normalized');
  assert.equal(citySlugFrom('Могилёв'), 'mogilev', 'label with ё normalized');
  assert.equal(citySlugFrom('Могилев'), 'mogilev', 'label without ё normalized');
  assert.equal(citySlugFrom('minsk'), 'minsk', 'slug passes through');
  assert.equal(citySlugFrom('all'), 'all', 'service value kept');
  assert.equal(citySlugFrom(''), null, 'empty city → null');
  assert.equal(cityLabel('minsk'), 'Минск', 'slug → human label');
  assert.equal(cityLabel('Минск'), 'Минск', 'label → same label (idempotent)');

  // Окно ежедневного отчёта: сутки ДО 09:00 по Минску, а не календарные сутки.
  // 09:00 Минска = 06:00 UTC.
  const at = (iso) => reportPeriodEndSec(Date.parse(iso));
  assert.equal(at('2026-10-22T12:00:00Z'), Date.parse('2026-10-22T06:00:00Z') / 1000, 'after send time → today 09:00');
  assert.equal(at('2026-10-22T06:00:00Z'), Date.parse('2026-10-22T06:00:00Z') / 1000, 'exactly at send time → today 09:00');
  assert.equal(at('2026-10-22T03:00:00Z'), Date.parse('2026-10-21T06:00:00Z') / 1000, 'before send time → yesterday 09:00');
  assert.equal(at('2026-10-22T05:59:59Z'), Date.parse('2026-10-21T06:00:00Z') / 1000, 'one second before → yesterday 09:00');
  assert.equal(msUntilNextMinsk(9, 0, Date.parse('2026-10-22T05:00:00Z')), 3600 * 1000, 'next send in 1h');

  // Бюджеты опроса: причины прерывания обхода площадок считаются раздельно,
  // а городские проверки считают реальные запросы к городам, а не позиции.
  resetBudgetStats();
  record.cityProbe(3);   // 3 города в одной проверке
  record.cityProbe(0);   // проверка без числового id — городов не опрошено (не считается)
  record.venueCrawlTruncated('budget');
  record.venueCrawlDeferred();
  record.venueCrawlTruncated('time');
  record.venueQuotaHit();
  const usage = snapshotBudgetStats();
  assert.equal(usage.cityProbes, 3, 'cityProbes counts real city requests');
  assert.equal(usage.cityChecks, 1, 'empty probe is not a city check');
  assert.equal(usage.cityProbesMax, 3, 'cityProbesMax is the busiest single check');
  assert.equal(usage.venueCrawlTimeTruncated, 1, 'time truncation counted separately');
  assert.equal(usage.venueCrawlBudgetTruncated, 1, 'budget truncation counted separately');
  assert.equal(usage.venueCrawlTruncated, 2, 'total truncation kept for compatibility');
  assert.equal(usage.venueCrawlDeferred, 1, 'deferred candidates counted');

  // check_log: новые колонки пишутся и читаются (миграция 0006).
  await db.insert(checkLog).values({
    checked: 5, cityProbes: 3, cityChecks: 2, cityProbesMax: 3, venueQuotaHit: 1,
    venueCrawlTruncated: 2, venueCrawlTimeTruncated: 1, venueCrawlBudgetTruncated: 1,
    venueCrawlDeferred: 1,
  }).run();
  const logRow = await db.select().from(checkLog).orderBy(desc(checkLog.id)).get();
  assert.equal(logRow.cityProbesMax, 3, 'city_probes_max persisted');
  assert.equal(logRow.venueCrawlBudgetTruncated, 1, 'venue_crawl_budget_truncated persisted');
  assert.equal(logRow.venueQuotaHit, 1, 'venue_quota_hit persisted');

  // Отчёт: разбивка «в продаже» — по источникам, а не все события кэша; обход
  // площадок, прерванный по бюджету, не выдаёт себя за прерывание по времени.
  const report = formatReport({
    date: '23 октября 2026',
    period: { label: '22.10 09:00 — 23.10 09:00' },
    users: { total: 1, newToday: 0, active24h: 1, active7d: 1 },
    watch: { total: 1, newToday: 0, byKind: {}, bySource: {} },
    events: {
      total: 4, newToday: 0, onSale: 2,
      onSaleBySource: { afisha: 1, ticketpro: 1 }, bySource: { afisha: 3, ticketpro: 1 },
    },
    notif: { today: 0, d7: 0, total: 0 },
    checks: {
      today: 1, items: 5, notified: 0, failed: 0, lastAt: 0,
      budget: {
        cycles: 1, items: 5, perCycleItems: 5,
        budget: { limit: 12, venueReserve: 4, venueLimit: 8 },
        detail: { limit: 12, spentAvg: 6, pct: 50, deniedCycles: 0, denied: 0 },
        city: { limit: 10, total: 3, checks: 2, perCheck: 1.5, max: 3, avg: 3, saturated: 0 },
        venues: { perQuery: 3, eventsLimit: 40, tried: 1, skipped: 2, quotaHit: 0, eventsTruncated: 0, resultsTruncated: 0 },
        crawl: {
          budgetMs: 20000, runs: 1, avgMs: 0, truncated: 2,
          timeTruncated: 1, budgetTruncated: 1, deferred: 1, pct: 0,
        },
      },
    },
  });
  assert.ok(report.includes('В продаже сейчас: <b>2</b> (Афиша 1, Ticketpro 1, BezKassira 0)'), 'on-sale breakdown uses on-sale events');
  assert.ok(report.includes('1.5 города на проверку'), 'city probes per check shown');
  assert.ok(report.includes('по времени прерван 1 раз'), 'time truncation shown honestly');
  assert.ok(report.includes('обход прерван из-за бюджета 1 раз (1 отложено)'), 'budget truncation shown separately');
  assert.ok(report.includes('(обычные 8 + площадки 4)'), 'budget split shown');

  console.log('✅ smoke PASS: db works (insert/onConflict/returning/filter/count/update/delete/order) + list render (emoji/links/deep-link) + venue query matching + budget counters + stats report');
}

main()
  .then(() => { cleanup(); })
  .catch((e) => { cleanup(); console.error('✗ smoke FAIL', e); process.exit(1); });
