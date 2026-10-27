// Снапшот БД на сервере: VACUUM INTO даёт консистентную копию вместе с WAL.
// Копировать только bot.db нельзя — получим "database disk image is malformed".
const Database = require('better-sqlite3');
const path = process.env.DB_PATH || '/data/bot.db';
const db = new Database(path, { readonly: true });
db.exec("VACUUM INTO '/tmp/snap.db'");
db.close();
console.log('snapshot ok:', path);
