// Логирование цикла проверки для последующего анализа.
//
// Зачем отдельный модуль: раньше единственным следом цикла была строка в
// check_log (агрегат без деталей) и `console.log` в cron.js. По ним нельзя
// ответить на вопросы «почему событие не проверилось» и «какая позиция тормозит».
//
// Что пишем:
//   1. Старт цикла — сколько позиций, как бюджеты поделены по чатам.
//   2. Итог цикла — ОДНА структурированная строка с ключом `check.summary`
//      (её удобно грепать и парсить: `docker logs tickets-bot-cron | grep check.summary`).
//   3. Опционально (CHECK_LOG_ITEMS=1) — строка на каждую позицию с исходом и
//      временем.
//   4. Медленные позиции — warning независимо от уровня: это главный сигнал
//      «сайт тормозит / таймаут».
//
// Формат: ключ + JSON. Плоские поля вместо вложенности — чтобы можно было
// разбирать регуляркой, не подключая парсер.
import { CHECK_LOG_LEVEL, CHECK_LOG_ITEMS, SLOW_ITEM_MS } from './config.js';

const LEVELS = { off: 0, summary: 1, items: 2, debug: 3 };
const level = LEVELS[String(CHECK_LOG_LEVEL || 'summary').toLowerCase()] ?? 1;
const itemsEnabled = CHECK_LOG_ITEMS || level >= 2;
const debugEnabled = level >= 3;

/** Включён ли вывод на заданном уровне (чтобы не собирать строки вхолостую). */
export const logEnabled = {
  summary: level >= 1,
  items: itemsEnabled,
  debug: debugEnabled,
};

// Короткий timestamp в ISO без миллисекунд — как в остальных логах cron.
function ts() {
  return new Date().toISOString();
}

/** Старт цикла: состав позиций и план бюджета по чатам. */
export function cycleStart({ items, perChatPlan, plainTotal, venueTotal }) {
  if (!logEnabled.summary) return;
  const byKind = { query: 0, event: 0, venue: 0 };
  for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  const chats = new Set(items.map((i) => i.chatId)).size;
  const plan = perChatPlan ? [...perChatPlan.values()] : [];
  const planMin = plan.length ? Math.min(...plan) : 0;
  const planMax = plan.length ? Math.max(...plan) : 0;
  console.log(
    `[check] ${ts()} cycle.start items=${items.length} chats=${chats} ` +
    `query=${byKind.query || 0} event=${byKind.event || 0} venue=${byKind.venue || 0} ` +
    `budgetPlain=${plainTotal} budgetVenue=${venueTotal} ` +
    `perChat=${planMin === planMax ? planMin : `${planMin}..${planMax}`}`,
  );
}

/**
 * Итог одной позиции (уровень 'items').
 * @param {object} info
 * @param {number} info.id        id позиции
 * @param {string} info.kind      query | event | venue
 * @param {number} info.chatId    владелец
 * @param {string} info.outcome   исход (см. OUTCOME в checker.js)
 * @param {number} info.ms        сколько заняло
 * @param {number} info.notified  сколько уведомлений отправлено
 * @param {string} [info.detail]  уточнение (запрос, причина)
 */
export function itemDone({ id, kind, chatId, outcome, ms, notified, detail }) {
  if (logEnabled.items) {
    const extra = detail ? ` detail=${JSON.stringify(detail)}` : '';
    console.log(
      `[check] ${ts()} item id=${id} kind=${kind} chat=${chatId} ` +
      `outcome=${outcome} ms=${ms} notified=${notified}${extra}`,
    );
  }
  if (ms >= SLOW_ITEM_MS) {
    console.warn(
      `[check] ${ts()} slow-item id=${id} kind=${kind} ms=${ms} outcome=${outcome} ` +
      `threshold=${SLOW_ITEM_MS}`,
    );
  }
}

/** Причина пропуска — только на уровне 'debug' (в больших циклах их много). */
export function skip({ id, reason, detail }) {
  if (!debugEnabled) return;
  const extra = detail ? ` detail=${JSON.stringify(detail)}` : '';
  console.log(`[check] ${ts()} skip id=${id} reason=${reason}${extra}`);
}

/**
 * Итог цикла — одна строка со всеми значимыми числами.
 * Дублирует check_log, но доступна в `docker logs` сразу, без запросов к БД.
 */
export function cycleSummary({ durationMs, checked, notified, failed, usage, cache, ordered, perChatPlan }) {
  if (!logEnabled.summary) return;
  const plan = perChatPlan ? [...perChatPlan.values()] : [];
  const summary = {
    ms: durationMs,
    checked,
    notified,
    failed,
    spent: usage.detailSpent,
    denied: usage.detailDenied,
    perChatDenied: usage.perChatDenied,
    cacheHit: cache.hits,
    cacheMiss: cache.misses,
    cacheJoin: cache.joins,
    presaleSkipped: usage.presaleSkipped,
    cityProbes: usage.cityProbes,
    venueTried: usage.queryVenuesTried,
    venueSkipped: usage.queryVenuesSkipped,
    venueTrunc: usage.venueEventsTruncated,
    resTrunc: usage.resultsTruncated,
    planSum: plan.reduce((a, b) => a + b, 0),
    orderHead: (ordered || []).slice(0, 5).map((i) => i.id),
  };
  console.log(`[check] ${ts()} check.summary ${JSON.stringify(summary)}`);
}

/** Ошибка позиции — всегда (не зависит от уровня). */
export function itemFailed({ id, kind, chatId, err, ms }) {
  console.warn(
    `[check] ${ts()} item.failed id=${id} kind=${kind} chat=${chatId} ms=${ms} ` +
    `error=${JSON.stringify(String(err && err.message || err))}`,
  );
}

/** Проблема одного источника внутри позиции (например, упал поиск афиши). */
export function sourceError({ id, source, phase, err }) {
  console.warn(
    `[check] ${ts()} source.error id=${id} source=${source} phase=${phase} ` +
    `error=${JSON.stringify(String(err && err.message || err))}`,
  );
}
