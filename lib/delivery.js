// Состояние доставки уведомлений по чатам.
//
// Зачем: если пользователь заблокировал бота (или удалил его), Telegram отвечает
// 403 «Forbidden: bot was blocked by the user» на КАЖДУЮ отправку. Раньше это
// поднимало ошибку позиции — и в проде две заблокировавшие позиции давали
// 216 «ошибок» в сутки (все 356 item.failed за 3 дня — это 403), а цикл каждый
// раз заново тратил на них сетевые запросы к билетным сайтам.
//
// Теперь ошибка 403 записывается в users.blocked_at:
//   • позиции этого чата не проверяются вовсе (нет смысла искать билеты для
//     того, кто их не увидит);
//   • это НЕ считается ошибкой — в check_log идёт отдельным счётчиком;
//   • раз в BLOCKED_RECHECK_SEC (сутки) бот делает одну «пробную» отправку,
//     потому что пользователь мог разблокировать бота. Удачная отправка
//     снимает пометку.
//
// Кэш в памяти: решение «блокирован ли чат» нужно на каждой позиции цикла, а
// лишний запрос к БД на позицию в цикле — это 22 запроса на пустом месте.
// Сброс кэша — в начале каждого цикла (resetBlockedCache).
import { db } from '../db.js';
import { users } from '../schema.js';
import { eq, sql } from '../db.js';

// Через сколько повторять попытку для помеченного чата (мог разблокировать).
export const BLOCKED_RECHECK_SEC = 24 * 60 * 60;

// chatId → время последней попытки (unix) для ЧАТОВ, ПРОБУ КОТОРЫМ МЫ ДЕЛАЕМ в
// этом цикле. Нужен, чтобы не повторять пробу каждую позицию чата.
let probeSent = new Set();

export function resetBlockedCache() {
  probeSent = new Set();
}

// Telegram отвечает 403 и текстом про блокировку. Это НЕ сбой сети и НЕ баг
// контента: повторять бессмысленно, пока пользователь не разблокирует бота.
export function isBlockedError(err) {
  if (!err) return false;
  if (Number(err.code) === 403) return true;
  const text = String(err.description || err.message || '');
  return /bot was blocked by the user|user is deactivated|chat not found/i.test(text);
}

/**
 * Доставляемы ли уведомления в чат.
 *
 * @param {number} chatId
 * @returns {Promise<boolean>} false — чат заблокировал бота (проверять позиции
 *   этого чата бессмысленно)
 */
export async function isChatDeliverable(chatId) {
  const row = await db
    .select({ blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.chatId, chatId))
    .get();
  // Пользователя может не быть в базе (старые чаты): считаем доставляемым —
  // ровно так работало до появления пометки.
  if (!row || !row.blockedAt) return true;
  const now = Math.floor(Date.now() / 1000);
  // Пора попробовать ещё раз: пользователь мог вернуться.
  if (now - Number(row.blockedAt) >= BLOCKED_RECHECK_SEC) return true;
  return false;
}

// Пометить чат как заблокировавший бота. Повторные вызовы в том же цикле
// бесплатны (одна запись на чат за цикл).
export async function markChatBlocked(chatId) {
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(users)
    .set({ blockedAt: now })
    .where(eq(users.chatId, chatId))
    .run();
}

// Отправка дошла — снимаем пометку (пользователь разблокировал бота).
export async function markChatDeliverable(chatId) {
  await db
    .update(users)
    .set({ blockedAt: null })
    .where(sql`${users.chatId} = ${chatId} AND ${users.blockedAt} IS NOT NULL`)
    .run();
}

/**
 * Нужно ли СЕЙЧАС пробовать отправить в помеченный чат.
 *
 * Вызывается только когда сообщение уже готово к отправке: для заблокированного
 * чата изредка (раз в BLOCKED_RECHECK_SEC) нужна одна попытка, чтобы заметить
 * разблокировку. Неудачная попытка обновляет blocked_at и откладывает следующую.
 *
 * @param {number} chatId
 * @returns {Promise<boolean>}
 */
export async function shouldProbeBlockedChat(chatId) {
  if (probeSent.has(chatId)) return false;
  const row = await db
    .select({ blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.chatId, chatId))
    .get();
  if (!row || !row.blockedAt) return true;
  const now = Math.floor(Date.now() / 1000);
  if (now - Number(row.blockedAt) >= BLOCKED_RECHECK_SEC) {
    probeSent.add(chatId);
    return true;
  }
  return false;
}

// Счётчик «чатов, которые не доставляются» — для статистики здоровья.
export async function blockedChatCount() {
  const row = await db
    .select({ n: sql`COUNT(*)` })
    .from(users)
    .where(sql`${users.blockedAt} IS NOT NULL`)
    .get();
  return Number(row && row.n) || 0;
}
