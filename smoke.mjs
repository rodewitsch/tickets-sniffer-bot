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
const { users, events, watchItems, checkLog, venueQueue, notifications } = await import('./schema.js');
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

  // venue_queue: уникальность (позиция, площадка) — на неё опирается enqueueVenue
  // (onConflictDoNothing) и дедупликация обхода. Индекс объявлен только в SQL
  // миграции, поэтому проверяем его наличие явно, а не «на глаз».
  const vqIdx = sqlite.prepare('PRAGMA index_list(venue_queue)').all();
  const uniq = vqIdx.find((i) => i.name === 'uidx_venue_queue_item_slug');
  assert.ok(uniq, 'venue_queue has uidx_venue_queue_item_slug');
  assert.equal(uniq.unique, 1, 'uidx_venue_queue_item_slug is UNIQUE');
  assert.ok(vqIdx.some((i) => i.name === 'idx_venue_queue_due'), 'venue_queue has due_at index');

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

  // Планирование бюджета «на чат» (lib/checker.js): сумма квот НИКОГДА не больше
  // бюджета (иначе лимит на чат ограничивал бы не то), и каждый чат получает
  // минимум, если бюджета хватает на всех.
  const { planPerChatAllocation } = await import('./lib/checker.js');
  const sumPlan = (plan) => [...plan.values()].reduce((a, b) => a + b, 0);
  for (const total of [1, 2, 3, 7, 16, 24, 100]) {
    for (const widths of [[1], [1, 1, 1], [6, 1, 1, 1, 1, 1, 1], [3, 3, 3], [12, 9, 7, 5, 3, 1]]) {
      const items = [];
      widths.forEach((n, chatId) => {
        for (let i = 0; i < n; i++) items.push({ chatId, kind: 'query', id: `${chatId}-${i}` });
      });
      const plan = planPerChatAllocation(items, total);
      assert.ok(sumPlan(plan) <= total, `plan sum ${sumPlan(plan)} <= ${total} (widths ${widths})`);
      assert.equal(plan.size, widths.length, 'every chat has a quota entry');
      for (const v of plan.values()) assert.ok(v >= 0, 'no negative quotas');
    }
  }

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

  // Миграция 0013: блокировка бота пользователем. Две вещи проверяем отдельно:
  //   1) счётчик blocked_chat — отдельная колонка, а не error_items (иначе
  //      «пользователь заблокировал бота» выглядело как поломка чекера);
  //   2) users.blocked_at управляет пропуском позиций в lib/delivery.js.
  resetBudgetStats();
  record.blockedChat();
  record.blockedChat();
  record.errorItem();
  const blockedUsage = snapshotBudgetStats();
  assert.equal(blockedUsage.blockedChat, 2, 'blocked chat skips counted separately');
  assert.equal(blockedUsage.errorItems, 1, 'error_items is not polluted by blocked chats');

  const { isBlockedError, isChatDeliverable, markChatBlocked, markChatDeliverable, shouldProbeBlockedChat, resetBlockedCache } = await import('./lib/delivery.js');
  const blockedChatId = 900001;
  await db.insert(users).values({ chatId: blockedChatId }).run();
  await db.insert(watchItems).values({ chatId: blockedChatId, kind: 'query', query: 'стас михайлов' }).run();
  assert.equal(await isChatDeliverable(blockedChatId), true, 'new chat is deliverable');
  await markChatBlocked(blockedChatId);
  // 403 = удаление данных, а не пометка: подписки того, кто заблокировал бота,
  // ему не нужны, а в отчёте они каждый день выглядели «мёртвыми позициями».
  const blockedUser = await db.select().from(users).where(eq(users.chatId, blockedChatId)).get();
  assert.equal(blockedUser, undefined, 'blocked chat user row deleted');
  const blockedItems = await db.select().from(watchItems).where(eq(watchItems.chatId, blockedChatId)).all();
  assert.equal(blockedItems.length, 0, 'blocked chat watch items deleted');
  // Строки users больше нет — второй вызов просто ничего не находит.
  await markChatBlocked(blockedChatId);
  // Без строки в users чат считается доставляемым: удалять больше нечего.
  assert.equal(await isChatDeliverable(blockedChatId), true, 'deleted chat is not skipped (nothing to check)');
  // Пробная отправка не нужна и не должна зацикливаться.
  resetBlockedCache();
  assert.equal(await shouldProbeBlockedChat(blockedChatId), true, 'deleted chat may be sent to');
  // Чат не в базе (старые пользователи) — считаем доставляемым, как раньше.
  assert.equal(await isChatDeliverable(123456789), true, 'unknown chat is deliverable');
  resetBlockedCache();
  assert.equal(await shouldProbeBlockedChat(123456789), true, 'unknown chat may be sent to');
  // markChatDeliverable по несуществующей строке — no-op, не падает.
  await markChatDeliverable(blockedChatId);
  // Распознавание 403: код ошибки и текст Telegram.
  assert.equal(isBlockedError({ code: 403 }), true, '403 by code');
  assert.equal(isBlockedError({ message: 'sendMessage: Forbidden: bot was blocked by the user (403)' }), true, '403 by message');
  assert.equal(isBlockedError({ code: 429, message: 'too many requests' }), false, 'rate limit is not a block');
  assert.equal(isBlockedError({ code: 400, message: 'bad request' }), false, 'bad request is not a block');

  await db.insert(checkLog).values({ checked: 2, blockedChat: 2 }).run();
  const blockedLogRow = await db.select().from(checkLog).orderBy(desc(checkLog.id)).get();
  assert.equal(blockedLogRow.blockedChat, 2, 'blocked_chat persisted (migration 0013)');

  // «🚪 Отключить бота»: полное удаление данных пользователя (lib/watch.js).
  //
  // Главное, что здесь защищаем, — ЧУЖИЕ данные не должны пострадать: очереди
  // площадок ссылаются на позиции по id, а удаление идёт «по чату», и без
  // явной проверки легко снести строки соседа. Плюс проверяем, что не остаётся
  // «сирот» в venue_queue после удаления позиций (иначе обход ходил бы по ним
  // вечно) и что повторный вызов безопасен.
  const { deleteAllUserData, addWatchItem, listWatchItems } = await import('./lib/watch.js');

  // Позиции заблокированного чата не должны попадать в «залипшие»: их пропуск —
  // осознанное решение, а не голод. Иначе отчёт каждый день показывал бы
  // «залипшие позиции 🟡» для 9 из 22 позиций (в проде так и было).
  {
    const { collectStats } = await import('./lib/stats.js');
    const stuckChat = 900002;
    const freshChat = 900003;
    await db.insert(users).values({ chatId: stuckChat, blockedAt: Math.floor(Date.now() / 1000) }).run();
    await db.insert(users).values({ chatId: freshChat }).run();
    const oldTs = Math.floor(Date.now() / 1000) - 72 * 3600;
    await addWatchItem({ chatId: stuckChat, kind: 'query', query: 'залипший-блок' });
    await addWatchItem({ chatId: freshChat, kind: 'query', query: 'залипший-живой' });
    await db.update(watchItems).set({ lastCheckedAt: oldTs }).where(eq(watchItems.chatId, stuckChat)).run();
    await db.update(watchItems).set({ lastCheckedAt: oldTs }).where(eq(watchItems.chatId, freshChat)).run();
    const statsNow = await collectStats();
    const stuckTitles = statsNow.checks.health.stuckItems.map((s) => s.title);
    assert.ok(!stuckTitles.includes('залипший-блок'), 'blocked chat positions are not reported as stuck');
    assert.ok(stuckTitles.includes('залипший-живой'), 'genuinely stuck position is still reported');

    // Долг у заблокированного чата не имеет смысла: позицию не проверяют, значит
    // «отработать» его она не может. Остатки сбрасываются (в проде три позиции
    // висели с deferStreak 1 и разбор советовал поднять им приоритет).
    const { bumpWatchItemDefer, clearBlockedChatDebt } = await import('./lib/watch.js');
    const blockedItem = (await listWatchItems(stuckChat))[0];
    await bumpWatchItemDefer(blockedItem.id);
    const liveItem = (await listWatchItems(freshChat))[0];
    await bumpWatchItemDefer(liveItem.id);
    await clearBlockedChatDebt();
    const blockedAfter = (await db.select().from(watchItems).where(eq(watchItems.id, blockedItem.id)).get());
    const liveAfter = (await db.select().from(watchItems).where(eq(watchItems.id, liveItem.id)).get());
    assert.equal(blockedAfter.deferStreak, 0, 'blocked chat debt is cleared');
    assert.equal(liveAfter.deferStreak, 1, 'debt of a live chat is kept');

    await deleteAllUserData(stuckChat);
    await deleteAllUserData(freshChat);
  }
  const { disableConfirmText, disabledText, mainReplyKeyboard, DISABLE_BUTTON } = await import('./lib/menus.js');
  const victim = 900002;
  const neighbour = 900003;
  await deleteAllUserData(victim);
  await deleteAllUserData(neighbour);

  await db.insert(users).values([{ chatId: victim }, { chatId: neighbour }]).run();
  const v1 = await addWatchItem({ chatId: victim, kind: 'query', query: 'театр' });
  const v2 = await addWatchItem({ chatId: victim, kind: 'venue', query: 'Молодёжный театр', eventUrl: 'https://24afisha.by/ru/object/332-x' });
  const n1 = await addWatchItem({ chatId: neighbour, kind: 'query', query: 'кино' });
  await db.insert(notifications).values([
    { chatId: victim, eventId: 1, dedupeKey: 'ev:del-victim:1' },
    { chatId: neighbour, eventId: 2, dedupeKey: 'ev:del-neighbour:1' },
  ]).run();
  await db.insert(venueQueue).values([
    { watchItemId: v1.row.id, chatId: victim, slug: '332-x', url: 'https://24afisha.by/ru/object/332-x', dueAt: 0 },
    { watchItemId: v2.row.id, chatId: victim, slug: '4950-z', url: 'https://24afisha.by/ru/object/4950-z', dueAt: 0 },
    { watchItemId: n1.row.id, chatId: neighbour, slug: '999-y', url: 'https://24afisha.by/ru/object/999-y', dueAt: 0 },
  ]).run();

  const del = await deleteAllUserData(victim);
  assert.equal(del.watchItems, 2, 'both positions deleted');
  assert.equal(del.venueQueue, 2, 'queue rows of the chat and of its positions deleted');
  assert.equal(del.notifications, 1, 'notification history deleted');
  assert.equal(del.users, 1, 'user row deleted');
  assert.equal((await listWatchItems(victim)).length, 0, 'no positions left for the user');
  assert.equal((await db.select().from(users).where(eq(users.chatId, victim)).all()).length, 0, 'user record gone');
  // Чужой пользователь не затронут.
  assert.equal((await listWatchItems(neighbour)).length, 1, 'neighbour keeps their position');
  assert.equal((await db.select().from(users).where(eq(users.chatId, neighbour)).all()).length, 1, 'neighbour user kept');
  assert.equal((await db.select().from(venueQueue).where(eq(venueQueue.chatId, neighbour)).all()).length, 1, 'neighbour queue kept');
  assert.equal((await db.select().from(notifications).where(eq(notifications.chatId, neighbour)).all()).length, 1, 'neighbour notifications kept');
  // Повторный клик по «удалить» не должен падать.
  const delAgain = await deleteAllUserData(victim);
  assert.equal(delAgain.watchItems, 0, 'repeated deletion is a no-op');
  await deleteAllUserData(neighbour);

  // Подтверждение обязанно называть число позиций (иначе человек не понимает,
  // что именно потеряет) и не должно обещать удаление кнопкой без вопроса.
  assert.ok(disableConfirmText(3).includes('3 позиции'), 'confirm names the item count');
  assert.ok(disableConfirmText(5).includes('5 позиций'), 'confirm handles plural');
  assert.ok(disabledText(del).includes('удалены'), 'result confirms deletion');
  // «Отключить бота» — не в reply-клавиатуре, а в разделе «Помощь».
  const { helpKeyboard } = await import('./lib/menus.js');
  assert.ok(!JSON.stringify(mainReplyKeyboard('https://x', false)).includes(DISABLE_BUTTON), 'disable button absent from reply keyboard');
  assert.ok(JSON.stringify(helpKeyboard()).includes('account:disable'), 'disable action present in help keyboard');

  // «🔕 Больше не уведомлять» глушит ОДНО событие, а не всю подписку.
  //
  // Это и был баг: под словом «театр» лежат десятки спектаклей, и нажатие под
  // одним выключало слово целиком. Проверяем именно то, из-за чего кнопка
  // переделывалась: позиция ОСТАЁТСЯ активной, глушится только её событие.
  const { muteEvent, isEventMuted, listMutedEvents, unmuteEvent, unmuteAllEvents } = await import('./lib/watch.js');
  const { ticketKeyboard, renderMutedEvents } = await import('./lib/menus.js');
  const muteChat = 900004;
  await deleteAllUserData(muteChat);
  await db.insert(users).values({ chatId: muteChat }).run();
  const word = await addWatchItem({ chatId: muteChat, kind: 'query', query: 'театр' });
  const keyA = 'ev:цветы для элджернона:20740';
  const keyB = 'ev:ревизор:20741';
  // Короткий ключ, который ГАРАНТИРОВАННО влезает в callback_data (64 байта
  // вместе с `mute:<id>:`): длинные ключи заменяются меткой и восстанавливаются
  // из карточки, поэтому «ключ доехал в кнопке» проверяем на коротком.
  const keyShort = 'ev:чайка:20768';

  // Кнопка несёт и позицию (найти владельца), и ключ события (что глушить).
  const kb = ticketKeyboard({ source: 'afisha', url: 'https://24afisha.by/ru/minsk/event/x' }, word.row.id, keyShort);
  const muteBtn = kb.inline_keyboard.flat().find((b) => (b.callback_data || '').startsWith('mute:'));
  assert.ok(muteBtn, 'mute button rendered when the event key is known');
  assert.equal(
    Buffer.from(muteBtn.callback_data.split(':')[2], 'base64url').toString('utf8'),
    keyShort,
    'callback_data carries the event key',
  );
  // Telegram пускает в callback_data не больше 64 БАЙТ, иначе 400
  // BUTTON_DATA_INVALID на ВСЁ сообщение (так «сломались» две площадки в проде:
  // failStreak 52 и 61, а ошибка выглядела как сбой площадки). Длинный ключ
  // заменяется меткой, ключ восстанавливается из карточки.
  for (const longTitle of [
    'Цветы для Элджернона',
    'Старая волшебная сказка',
    'Представление у Ёлки "Где же ты, Снегурочка?". Премьера спектакля "Белоснежка. Новогодняя история"',
  ]) {
    const longKey = `ev:${longTitle.toLowerCase().replace(/ё/g, 'е')}:20860`;
    const longKb = ticketKeyboard({ source: 'afisha', url: 'https://24afisha.by/ru/minsk/event/x' }, word.row.id, longKey);
    for (const b of longKb.inline_keyboard.flat()) {
      if (!b.callback_data) continue;
      assert.ok(
        Buffer.byteLength(b.callback_data, 'utf8') <= 64,
        `callback_data fits Telegram's 64-byte limit (${Buffer.byteLength(b.callback_data, 'utf8')}B): ${JSON.stringify(longTitle)}`,
      );
    }
  }
  // Без ключа события глушить нечего — кнопку не показываем.
  const kbNoKey = ticketKeyboard({ source: 'afisha', url: 'https://x' }, word.row.id);
  assert.ok(!kbNoKey.inline_keyboard.flat().some((b) => (b.callback_data || '').startsWith('mute:')), 'no mute button without an event key');

  // ── failStreak: счётчик текущего состояния, а не вечная отметина ──────────
  // В проде позиции показывали «71 падение подряд», хотя неделю не проверялись
  // (их чат заблокировал бота), и AI-разбор советовал чинить рабочий адрес.
  const { bumpWatchItemFailures, clearStaleFailStreaks, markWatchItemChecked } = await import('./lib/watch.js');
  const streakId = word.row.id;
  for (let i = 0; i < 4; i++) await bumpWatchItemFailures(streakId);
  let streakRow = await db.select().from(watchItems).where(eq(watchItems.id, streakId)).get();
  assert.equal(streakRow.failStreak, 4, 'failStreak accumulates on failures');
  // Успешная проверка сбрасывает серию И долг.
  await markWatchItemChecked(streakId);
  streakRow = await db.select().from(watchItems).where(eq(watchItems.id, streakId)).get();
  assert.equal(streakRow.failStreak, 0, 'successful check resets failStreak');
  // Серия, зависшая у позиции без проверок дольше суток, обнуляется уборкой.
  // Свежая серия (проверялась 2 часа назад) должна ПЕРЕЖИТЬ уборку…
  await db.update(watchItems)
    .set({ failStreak: 71, lastCheckedAt: Math.floor(Date.now() / 1000) - 7200 })
    .where(eq(watchItems.id, streakId))
    .run();
  assert.equal(await clearStaleFailStreaks(24 * 60 * 60), 0, 'fresh streak is not cleared');
  streakRow = await db.select().from(watchItems).where(eq(watchItems.id, streakId)).get();
  assert.equal(streakRow.failStreak, 71, 'recent streak survives the sweep');
  // …а протухшая (сутки без проверок) — обнуляется.
  await db.update(watchItems)
    .set({ lastCheckedAt: Math.floor(Date.now() / 1000) - 48 * 3600 })
    .where(eq(watchItems.id, streakId))
    .run();
  const clearedCount = await clearStaleFailStreaks(24 * 60 * 60);
  assert.ok(clearedCount >= 1, 'stale failStreak is cleared');
  streakRow = await db.select().from(watchItems).where(eq(watchItems.id, streakId)).get();
  assert.equal(streakRow.failStreak, 0, 'stale streak reset to zero');

  await muteEvent({ chatId: muteChat, dedupeKey: keyA, title: 'Цветы для Элджернона' });
  assert.equal(await isEventMuted(muteChat, keyA), true, 'muted event is flagged');
  assert.equal(await isEventMuted(muteChat, keyB), false, 'other events of the same keyword stay active');
  // ГЛАВНОЕ требование: сама подписка не тронута.
  const wordAfter = await listWatchItems(muteChat);
  assert.equal(wordAfter.length, 1, 'keyword subscription survives muting an event');
  assert.equal(wordAfter[0].active, true, 'keyword remains active');
  assert.equal(wordAfter[0].id, word.row.id, 'same subscription row untouched');
  // Повторное нажатие не плодит записи.
  await muteEvent({ chatId: muteChat, dedupeKey: keyA, title: 'Цветы для Элджернона' });
  assert.equal((await listMutedEvents(muteChat)).length, 1, 'muting is idempotent');
  // Чужая заглушка не действует на другого пользователя.
  assert.equal(await isEventMuted(900005, keyA), false, 'mutes are per-chat');
  // Снятие заглушки возвращает событие.
  const mutedRow = (await listMutedEvents(muteChat))[0];
  await unmuteEvent(muteChat, mutedRow.id);
  assert.equal(await isEventMuted(muteChat, keyA), false, 'unmute restores the event');
  await muteEvent({ chatId: muteChat, dedupeKey: keyB, title: 'Ревизор' });
  await unmuteAllEvents(muteChat);
  assert.equal((await listMutedEvents(muteChat)).length, 0, 'unmute all clears the list');
  // «Отключить бота» обязан чистить и заглушки.
  await muteEvent({ chatId: muteChat, dedupeKey: keyA, title: 'X' });
  const delMuted = await deleteAllUserData(muteChat);
  assert.equal(delMuted.mutedEvents, 1, 'account deletion removes muted events');
  assert.ok(renderMutedEvents([]).includes('сама подписка продолжает работать'), 'empty muted list explains the mechanism');

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

  // Блок «Здоровье»: появляется при наличии циклов и даёт оценку, а не сырые
  // числа. Проверяем и «здоровый», и «проблемный» случай — иконка должна
  // меняться, иначе блок бесполезен.
  const healthBase = {
    date: '23 октября 2026',
    period: { label: '22.10 09:00 — 23.10 09:00' },
    users: { total: 1, newToday: 0, active24h: 1, active7d: 1 },
    watch: { total: 1, newToday: 0, byKind: {}, bySource: {} },
    events: { total: 1, newToday: 0, onSale: 1, onSaleBySource: {}, bySource: {} },
    notif: { today: 0, d7: 0, total: 0 },
    checks: {
      today: 10, items: 5, notified: 0, failed: 0, lastAt: 0,
      health: {
        cycles: 10, avgMs: 90000, medianMs: 28000, maxMs: 424000, slowCycles: 5,
        failed: 0, prevFailed: 2, venueSkipped: 713, prevVenueSkipped: 1296,
        venueTried: 297, venueFailed: 40, venueFailedNow: 4, venueRenamed: 2,
        crawlPct: 1, crawlTruncated: 5, budgetPct: 35, lastAgeMin: 1,
      },
      budget: { cycles: 0 },
    },
  };
  const healthy = formatReport(healthBase);
  assert.ok(healthy.includes('🩺 <b>Здоровье</b>'), 'health block rendered');
  assert.ok(healthy.includes('Ошибки позиций ✅ — 0 за сутки (было 2)'), 'errors compared with yesterday');
  assert.ok(healthy.includes('медиана 28 с'), 'cycle time uses median, not outlier-heavy average');
  assert.ok(healthy.includes('297 обходов (было 1296 — стало лучше)'), 'crawl trend shown');
  // Счётчик битых — снимок «сейчас», а не сумма событий за сутки: одна мёртвая
  // запись, переопрашиваемая каждые 1–12 ч, давала «40» при четырёх реальных.
  assert.ok(healthy.includes('битых площадок сейчас: 4'), 'broken count is a snapshot, not a daily sum');
  assert.ok(healthy.includes('попыток за сутки 40'), 'attempt count kept as secondary info');
  assert.ok(healthy.includes('исправлено переименованных площадок: 2'), 'renamed venues reported');

  const sick = formatReport({
    ...healthBase,
    checks: {
      ...healthBase.checks,
      health: { ...healthBase.checks.health, failed: 12, medianMs: 240000, venueTried: 0, lastAgeMin: 999 },
    },
  });
  assert.ok(sick.includes('Ошибки позиций 🔴'), 'many errors downgrade to red');
  assert.ok(sick.includes('Длительность цикла 🔴'), 'slow cycles downgrade to red');
  assert.ok(sick.includes('Обход площадок 🔴'), 'no crawls downgrade to red');

  // Без циклов блок не печатается (свежая БД / первый запуск).
  const empty = formatReport({ ...healthBase, checks: { ...healthBase.checks, health: { cycles: 0 } } });
  assert.ok(!empty.includes('🩺'), 'health block hidden without cycles');

  console.log('✅ smoke PASS: db works (insert/onConflict/returning/filter/count/update/delete/order) + list render (emoji/links/deep-link) + venue query matching + budget counters + blocked-chat delivery + account deletion + stats report + health block');
}

main()
  .then(() => { cleanup(); })
  .catch((e) => { cleanup(); console.error('✗ smoke FAIL', e); process.exit(1); });
