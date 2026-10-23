// Применение миграций БД (drizzle-kit генерирует SQL в drizzle/, здесь применяем).
// Запуск: node migrate.js
// Вызывается при старте server.js И cron.js: оба процесса пишут в базу, и ни один
// не должен зависеть от того, успел ли соседний контейнер обновить схему.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { sql } from 'drizzle-orm';
import { db } from './db.js';

export function runMigrations() {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] applied');
  // SQLite в WAL-режиме не отдаёт занятое место сам: файл -wal пухнет (в проде
  // доходило до 4 МБ при 230 КБ самой базы), пока не будет чекпоинта. Делаем его
  // при старте — оба контейнера (bot, cron) держат базу открытой долго.
  try {
    db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  } catch (e) {
    console.warn('[migrate] wal checkpoint skipped:', e && e.message || e);
  }
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
