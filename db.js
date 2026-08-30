// Слой БД на Drizzle ORM + better-sqlite3.
// Экспортирует готовый `db` (drizzle) и пере-экспортирует нужные операторы,
// чтобы остальной код использовал стандартный Drizzle API (eq/and/desc/sql).
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

// Операторы и sql-тег из drizzle-orm
export { eq, ne, gt, gte, lt, lte, and, or, not, inArray, like, notLike, isNull, isNotNull, desc, asc, sql } from 'drizzle-orm';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bot.db');

function open() {
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export const sqlite = open();
export const db = drizzle(sqlite);
export default db;
