// Удаляет события, которые ни разу не проверялись (last_checked_at IS NULL).
//
// Безопасно: уведомления пишутся только ПОСЛЕ проверки (notifyIfDue вызывается
// на уже сохранённом upsertEvent событии, а upsertEvent всегда ставит
// lastCheckedAt), поэтому у такой строки нет ссылок из notifications. Внешних
// ключей в SQLite нет, так что DELETE никого не зацепит.
//
// Запуск на сервере (better-sqlite3 есть только в контейнере):
//   docker cp scripts/remove-never-checked.cjs tickets-bot:/app/
//   docker exec -w /app tickets-bot node remove-never-checked.cjs
const Database = require('better-sqlite3');
const path = process.env.DB_PATH || '/data/bot.db';
const db = new Database(path);

const before = db
  .prepare('SELECT id, source, uid, title, url FROM events WHERE last_checked_at IS NULL')
  .all();
console.log(`до удаления (${before.length}):`, JSON.stringify(before, null, 2));

const info = db.prepare('DELETE FROM events WHERE last_checked_at IS NULL').run();
console.log('удалено строк:', info.changes);
db.close();
