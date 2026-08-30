// Применение миграций БД (drizzle-kit генерирует SQL в drizzle/, здесь применяем).
// Запуск: node migrate.js
// Вызывается также при старте server.js.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './db.js';

export function runMigrations() {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] applied');
}

// Прямой запуск из CLI.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  try {
    runMigrations();
  } catch (e) {
    console.error('[migrate] error:', e && e.message || e);
    process.exit(1);
  }
}
