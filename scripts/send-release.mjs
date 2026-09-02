// Утилита: рассылка анонса версии владельцу (preview) или всем пользователям (broadcast).
// Переиспользуется на каждый релиз: текст сообщения берётся из файла, чтобы не
// править код. Аргументы: <mode> preview|broadcast и путь к файлу с текстом.
//
// Использование:
//   BOT_TOKEN=... node scripts/send-release.mjs preview  messages/0.2.0.txt
//   BOT_TOKEN=... node scripts/send-release.mjs broadcast messages/0.2.0.txt
//
// Текст файла — HTML-разметка Telegram (можно с <b>, <i>, эмодзи). Переносы строк
// сохраняются как есть.
//
// broadcast берёт список чатов из таблицы users, поэтому на сервере указывайте
//   DB_PATH=/data/bot.db  (в Docker база лежит в томе /data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from '../api.js';
import db from '../db.js';
import { users } from '../schema.js';
import { STATS_CHAT_ID } from '../lib/config.js';

// Путь к папке scripts/ независимо от того, откуда запущен процесс.
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const mode = process.argv[2] || 'preview';
  const fileArg = process.argv[3];
  if (!['preview', 'broadcast'].includes(mode)) {
    console.error('Usage: node scripts/send-release.mjs [preview|broadcast] <path-to-message.txt>');
    process.exit(1);
  }
  if (!fileArg) {
    console.error('Missing message file. Usage: node scripts/send-release.mjs [preview|broadcast] <path-to-message.txt>');
    process.exit(1);
  }
  if (!process.env.BOT_TOKEN) {
    console.error('BOT_TOKEN is not set. Set it before running.');
    process.exit(1);
  }

  // Путь к тексту относительно папки проекта (git-путь) или абсолютный.
  const msgPath = path.isAbsolute(fileArg)
    ? fileArg
    : path.resolve(scriptsDir, '..', fileArg);
  let message;
  try {
    message = fs.readFileSync(msgPath, 'utf8').trim();
  } catch (e) {
    console.error(`Cannot read message file: ${msgPath} —`, e && e.message || e);
    process.exit(1);
  }
  if (!message) {
    console.error(`Message file is empty: ${msgPath}`);
    process.exit(1);
  }
  console.log(`[${mode}] message from ${msgPath} (${message.length} chars)`);

  if (mode === 'preview') {
    try {
      await api.sendMessage({ chat_id: STATS_CHAT_ID, text: message, parse_mode: 'HTML' });
      console.log(`[preview] sent to owner chat ${STATS_CHAT_ID}`);
    } catch (e) {
      console.error('[preview] failed:', e && e.message || e);
      process.exit(1);
    }
    return;
  }

  // broadcast: всем пользователям, последовательно, с защитой от блокировок.
  const rows = await db.select({ chatId: users.chatId }).from(users).all();
  console.log(`[broadcast] ${rows.length} users`);
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await api.sendMessage({ chat_id: row.chatId, text: message, parse_mode: 'HTML' });
      ok++;
    } catch (e) {
      failed++;
      console.warn(`[broadcast] skip chat ${row.chatId}: ${e && e.message || e}`);
    }
    await sleep(50); // ~20 msg/s — безопасно для лимитов Bot API
  }
  console.log(`[broadcast] done: ${ok} sent, ${failed} failed`);
}

main().catch((e) => {
  console.error('fatal:', e && e.message || e);
  process.exit(1);
});
