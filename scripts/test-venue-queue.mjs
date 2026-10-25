// Тест очереди площадок (venue_queue) на реальной SQLite.
// Запуск: node scripts/test-venue-queue.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.tmpdir(), `venue-queue-test-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

const { runMigrations } = await import('../migrate.js');
runMigrations();
const { default: db } = await import('../db.js');
const { watchItems } = await import('../schema.js');
const q = await import('../lib/venue-queue.js');

let fails = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) fails += 1;
};

const now = () => Math.floor(Date.now() / 1000);

// Позиция-ключевик, к которой привязаны площадки (FK нет — просто число).
const [item] = await db.insert(watchItems)
  .values({ chatId: 1, kind: 'query', query: 'театр', title: 'театр' })
  .returning();
const [other] = await db.insert(watchItems)
  .values({ chatId: 2, kind: 'query', query: 'РТБД', title: 'РТБД' })
  .returning();

const v1 = { uid: 'teatr-kukol-minsk', url: 'https://24afisha.by/ru/object/teatr-kukol-minsk', name: 'Театр кукол' };
const v2 = { uid: 'rtbd-minsk', url: 'https://24afisha.by/ru/object/rtbd-minsk', name: 'РТБД' };

// 1. Новая площадка ставится, повторная — нет (идемпотентность).
ok(await q.enqueueVenue({ watchItemId: item.id, chatId: 1, venue: v1, dueAt: now() }) === true, 'enqueue new venue');
ok(await q.enqueueVenue({ watchItemId: item.id, chatId: 1, venue: v1, dueAt: now() }) === false, 'enqueue duplicate is idempotent');
ok(await q.dueVenueCount() === 1, 'due count = 1');

// 2. Та же площадка у другой позиции — это отдельная запись (ключ: item+slug).
ok(await q.enqueueVenue({ watchItemId: other.id, chatId: 2, venue: v1, dueAt: now() }) === true, 'same venue for other item');

// 3. Повторный enqueue НЕ ускоряет отложенную площадку (иначе дальние обходились
//    бы каждый цикл — ровно то, что чиним).
const [row] = await q.dueVenues(10);
await q.rescheduleVenue(row.id, { dueAt: now() + 3600, cursor: 5 });
const before = (await q.dueVenues(10)).find((r) => r.id === row.id);
await q.enqueueVenue({ watchItemId: row.watchItemId, chatId: row.chatId, venue: v1, dueAt: now() });
const after = (await q.dueVenues(10)).find((r) => r.id === row.id);
ok(before === undefined && after === undefined, 're-enqueue does not resurrect deferred venue');
ok((await db.select().from((await import('../schema.js')).venueQueue).all())
  .find((r) => r.id === row.id).dueAt > now() + 3000, 'dueAt preserved');

// 4. dueVenues соблюдает лимит и порядок (самый просроченный — первым).
//    В очереди к этому моменту: 2 записи «сейчас» + rtbd на 100 секунд раньше,
//    поэтому первым обязан идти именно rtbd (а не порядок вставки).
await q.enqueueVenue({ watchItemId: item.id, chatId: 1, venue: v2, dueAt: now() - 100 });
const batch = await q.dueVenues(1);
ok(batch.length === 1 && batch[0].slug === 'rtbd-minsk', 'dueVenues orders by dueAt and respects limit');
const two = await q.dueVenues(2);
ok(two.length === 2, 'dueVenues respects limit=2');

// 5. failVenue откладывает с backoff и помечает failing.
await q.failVenue(batch[0].id, { dueAt: now(), attempts: 1 });
const failed = (await db.select().from((await import('../schema.js')).venueQueue).all())
  .find((r) => r.id === batch[0].id);
ok(!!failed.failing && failed.dueAt > now() + 3000, 'failVenue applies backoff');

// 6. pruneVenueQueue убирает записи неактивных позиций.
await q.pruneVenueQueue([item.id]);
const left = await db.select().from((await import('../schema.js')).venueQueue).all();
ok(left.every((r) => r.watchItemId === item.id), 'prune drops rows of removed items');
ok(left.length === 2, `prune kept ${left.length} rows for active item`);

// 7. РЕГРЕССИЯ: slug площадки из bycard-ссылки. Раньше парсер понимал только
//    /ru/object/<slug> и /ru/<city>/events/<slug>, поэтому bycard-ссылки
//    (их строит venueUrlByCard) давали пустой slug → fetchAfishaVenueEvents
//    молча возвращал venue=null, и площадка навсегда оставалась failing.
//    В проде так залипли 9 записей очереди.
const { afishaVenueSlugFromUrl } = await import('../lib/sources/afisha.js');
const SLUG = '158-respublikanskij-teatr-belorusskoj-dramaturgii';
ok(afishaVenueSlugFromUrl(`https://bycard.by/afisha/minsk/venues/${SLUG}`) === SLUG, 'slug from bycard venue url');
ok(afishaVenueSlugFromUrl(`https://24afisha.by/ru/object/${SLUG}`) === SLUG, 'slug from /ru/object/ url');
ok(afishaVenueSlugFromUrl('https://24afisha.by/ru/minsk/events/old-slug') === 'old-slug', 'slug from legacy url');
ok(afishaVenueSlugFromUrl('https://example.com/nope') === '', 'slug empty for unknown url');

// 8. РЕГРЕССИЯ: failVenue не должен уезжать на +41 день. VENUE_QUERY_RECHECK_MS
//    измеряется в миллисекундах, а dueAt — в секундах; передача «как есть»
//    отправляла запись на now + 3.6 млн секунд.
const { VENUE_QUERY_RECHECK_MS } = await import('../lib/config.js');
const failRow = await q.enqueueVenue({ watchItemId: item.id, chatId: 1, venue: { uid: 'fail-test', url: 'https://x/fail-test', name: 'fail' }, dueAt: now() });
ok(failRow === true, 'enqueue row for fail test');
const failId = (await db.select().from((await import('../schema.js')).venueQueue).all()).find((r) => r.slug === 'fail-test').id;
await q.failVenue(failId, { dueAt: now() + Math.round(VENUE_QUERY_RECHECK_MS / 1000), attempts: 1 });
const failAfter = (await db.select().from((await import('../schema.js')).venueQueue).all()).find((r) => r.id === failId);
const failDelay = failAfter.dueAt - now();
ok(failDelay > 0 && failDelay < 13 * 3600, `fail backoff in hours, not days (got ${Math.round(failDelay / 60)} min)`);

console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
// Соединение better-sqlite3 держит файл — закрываем перед удалением (в Windows
// иначе EBUSY).
const { sqlite } = await import('../db.js');
try { sqlite.close(); } catch { /* уже закрыто */ }
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* не критично для теста */ }
}
process.exit(fails ? 1 : 0);
