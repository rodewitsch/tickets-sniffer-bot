// Прогон реального AI-разбора на продовом снимке.
// Нужен ключ: $env:DEEPSEEK_API_KEY='sk-...'
// Запуск: node scripts/try-ai-report.mjs

import { collectDiagnostics } from '../lib/stats.js';
import { requestAiReport, aiReportEnabled } from '../lib/ai-report.js';
import db from '../db.js';

if (!aiReportEnabled()) {
  console.log('DEEPSEEK_API_KEY не задан — запрос пропущен');
  process.exit(0);
}

const snap = await collectDiagnostics();
const t0 = Date.now();
const text = await requestAiReport(snap);
const ms = Date.now() - t0;

console.log(`--- ответ за ${ms} мс ---`);
console.log(text ?? '(null)');
db.close?.();
