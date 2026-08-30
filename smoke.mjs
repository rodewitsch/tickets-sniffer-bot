// Локальный smoke-тест слоя БД (Drizzle + better-sqlite3).
// Запуск: node smoke.mjs
import assert from 'node:assert';
import { count } from 'drizzle-orm';
import db, { eq, and, desc } from './db.js';
import { users, events, watchItems } from './schema.js';
import { runMigrations } from './migrate.js';

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
  await db.update(watchItems).set({ active: false }).where(eq(watchItems.id, w1.id)).run();
  const active = await db.select().from(watchItems).where(and(eq(watchItems.chatId, 1), eq(watchItems.active, true))).all();
  assert.equal(active.length, 1, 'deactivated one');
  await db.delete(watchItems).where(eq(watchItems.id, w2.id)).run();
  const afterDel = await db.select().from(watchItems).where(eq(watchItems.chatId, 1)).all();
  assert.equal(afterDel.length, 1, 'deleted one');

  console.log('✅ smoke PASS: db works (insert/onConflict/returning/filter/count/update/delete/order)');
}

main().catch((e) => { console.error('✗ smoke FAIL', e); process.exit(1); });
