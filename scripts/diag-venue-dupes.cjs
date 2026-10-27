// Почему в очереди площадок видно одну и ту же площадку дважды.
// Запуск: docker exec -w /app tickets-bot-cron node scripts/diag-venue-dupes.cjs
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/bot.db', { readonly: true });

const rows = db
  .prepare(
    `SELECT id, watch_item_id, chat_id, slug, failing, due_at, last_crawled_at, url
       FROM venue_queue
      WHERE failing = 1
      ORDER BY slug, id`
  )
  .all();

console.log(`битых записей: ${rows.length}`);
for (const r of rows) console.log(JSON.stringify(r));

const distinct = new Set(rows.map((r) => r.url));
console.log(`уникальных url: ${distinct.size}`);

const bySlug = db
  .prepare(
    `SELECT slug, COUNT(*) n, COUNT(DISTINCT watch_item_id) items, COUNT(DISTINCT url) urls
       FROM venue_queue GROUP BY slug HAVING n > 1 ORDER BY n DESC`
  )
  .all();
console.log('\nслаги, встречающиеся несколько раз:');
for (const r of bySlug) console.log(JSON.stringify(r));

db.close();
