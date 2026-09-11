// Локальный smoke-тест слоя БД (Drizzle + better-sqlite3) и чистых хелперов
// рендера списка (эмодзи/ссылки). Запуск: node smoke.mjs
import assert from 'node:assert';
import { count } from 'drizzle-orm';
import db, { eq, and, desc } from './db.js';
import { users, events, watchItems } from './schema.js';
import { runMigrations } from './migrate.js';
import {
  renderWatchlist, itemEmoji, unsubDeepLink, unsubConfirmText, unsubConfirmKeyboard,
} from './lib/menus.js';

async function main() {
  // применяем миграции (как migrate), чтобы тест работал на чистой БД
  runMigrations();

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

  const emptyText = renderWatchlist([]);
  assert.ok(emptyText.includes('Список пуст') && emptyText.includes('Найти и следить'), 'empty list CTA');

  assert.ok(unsubConfirmText({ kind: 'event', source: 'afisha', category: 'Театр', title: 'Идиоты', city: 'minsk' }).includes('Отписаться?'), 'confirm text');
  const confirmKb = unsubConfirmKeyboard(5).inline_keyboard;
  assert.equal(confirmKb[0][0].callback_data, 'unsub:yes:5', 'confirm yes callback');
  assert.equal(confirmKb[1][0].callback_data, 'unsub:no:5', 'confirm no callback');

  console.log('✅ smoke PASS: db works (insert/onConflict/returning/filter/count/update/delete/order) + list render (emoji/links/deep-link)');
}

main().catch((e) => { console.error('✗ smoke FAIL', e); process.exit(1); });
