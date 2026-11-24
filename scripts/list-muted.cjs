// Показать сохранённые заглушки (по одной строке на событие).
// Запуск: node list-muted.cjs [chatId]
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || '/data/bot.db', { readonly: true });
const chatId = Number(process.argv[2]) || 0;
const rows = chatId
  ? db.prepare('SELECT chat_id, dedupe_key, title, date_text, muted_at FROM muted_events WHERE chat_id = ? ORDER BY title').all(chatId)
  : db.prepare('SELECT chat_id, dedupe_key, title, date_text, muted_at FROM muted_events ORDER BY chat_id, title').all();
console.log(JSON.stringify(rows, null, 1));
console.log(`rows=${rows.length}`);
db.close();
