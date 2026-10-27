// Разовый прогон диагностики: печатает снимок, который уйдёт в AI-разбор.
// Нужен, чтобы глазами проверить состав данных до деплоя.
// Запуск: node scripts/show-diagnostics.mjs

import { collectDiagnostics } from '../lib/stats.js';
import db from '../db.js';

const snap = await collectDiagnostics();
console.log(JSON.stringify(snap, null, 2));
const size = JSON.stringify(snap).length;
console.log(`\nразмер снимка: ${size} символов (~${Math.round(size / 3)} токенов)`);
db.close?.();
