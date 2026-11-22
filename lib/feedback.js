// Обращения владельцу: режим ввода и ОТВЕТ на обращение.
//
// Пользователь: «✍️ Сообщить об ошибке / пожелание» → следующее текстовое
// сообщение становится обращением (см. handlers/message.js), а не ключевым
// словом. Оно сохраняется в таблицу `feedback` (schema.js) и уходит владельцу
// (STATS_CHAT_ID) с кнопкой «Ответить».
//
// Владелец: нажал «Ответить» под обращением → вводит текст → бот пересылает
// ответ автору обращения от своего имени. Переписка видна обеим сторонам
// в чатах, личные контакты пользователя не нужны.
//
// Почему «на какое обращение сейчас отвечают» и message_id формы лежат в `meta`,
// а не в памяти модуля: нажатие кнопки может прийти после перезапуска `bot`
// (а в будущем — и в процессе `cron`), состоянии же нужно пережить рестарт.
// Ключи:
//   feedbackReplyTo — id обращения, на которое сейчас пишет владелец;
//   feedbackMsgId   — message_id формы с кнопкой «Отмена» (чтобы её убрать);
//   feedbackMsgKind — тип сообщения формы: text | photo | document.
import { api, BotApiError } from '../api.js';
import { db } from '../db.js';
import { feedback, meta } from '../schema.js';
import { eq, asc, sql } from '../db.js';
import { escapeHtml } from './util.js';

// Активные чаты в режиме ввода обращения.
const active = new Set();
const META_REPLY_TO = 'feedbackReplyTo';
const META_MSG_ID = 'feedbackMsgId';
const META_MSG_KIND = 'feedbackMsgKind';

export function feedbackSession(chatId) {
  return active.has(chatId);
}

export function startFeedback(chatId) {
  active.add(chatId);
}

export function clearFeedback(chatId) {
  active.delete(chatId);
}

// ── Обращение как запись в БД ───────────────────────────────────────────────

/** Сохранить обращение. Возвращает строку с id (нужен для кнопки «Ответить»). */
export async function saveFeedback({ chatId, authorName, authorUsername, text }) {
  const [row] = await db
    .insert(feedback)
    .values({
      chatId,
      authorName: authorName || null,
      authorUsername: authorUsername || null,
      text: String(text).slice(0, 4000),
    })
    .returning();
  return row;
}

export async function getFeedback(id) {
  if (!Number.isFinite(Number(id))) return null;
  const row = await db.select().from(feedback).where(eq(feedback.id, Number(id))).get();
  return row || null;
}

/** Открытые обращения (владелец: что ещё без ответа). */
export async function listOpenFeedback(limit = 20) {
  return db
    .select()
    .from(feedback)
    .where(eq(feedback.status, 'open'))
    .orderBy(asc(feedback.createdAt))
    .limit(limit)
    .all();
}

/** Сколько обращений без ответа (для подсказки в справке владельца). */
export async function countOpenFeedback() {
  const [row] = await db.select({ n: sql`count(*)` }).from(feedback).where(eq(feedback.status, 'open'));
  return Number(row?.n || 0);
}

/** Запомнить, какими сообщениями в чате владельца оформлен диалог. */
export async function setFeedbackOwnerMessage(id, ownerMsgId) {
  await db.update(feedback).set({ ownerMsgId }).where(eq(feedback.id, Number(id))).run();
}

/** Отметить ответ: текст, время, new message_id формы (если известен). */
export async function markFeedbackAnswered(id, { replyText, messageId = null }) {
  await db
    .update(feedback)
    .set({
      replyText: replyText || null,
      messageId: messageId ?? null,
      answeredAt: sql`unixepoch()`,
      status: 'answered',
    })
    .where(eq(feedback.id, Number(id)))
    .run();
}

// ── Состояние диалога владельца (в meta) ────────────────────────────────────

async function metaGet(key) {
  const row = await db.select().from(meta).where(eq(meta.key, key)).get();
  return row?.value ?? null;
}

async function metaSet(key, value) {
  await db
    .insert(meta)
    .values({ key, value: value == null ? null : String(value) })
    .onConflictDoUpdate({ target: meta.key, set: { value: value == null ? null : String(value) } })
    .run();
}

/** Владелец сейчас пишет ответ? Возвращает id обращения или null. */
export async function replySession() {
  const raw = await metaGet(META_REPLY_TO);
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function startReply(feedbackId, { messageId = null, messageKind = 'text' } = {}) {
  await metaSet(META_REPLY_TO, feedbackId);
  await metaSet(META_MSG_ID, messageId);
  await metaSet(META_MSG_KIND, messageKind);
}

export async function clearReply() {
  await metaSet(META_REPLY_TO, null);
  await metaSet(META_MSG_ID, null);
  await metaSet(META_MSG_KIND, null);
}

/** Где сейчас нарисована форма ответа (чтобы убрать клавиатуру после ответа). */
export async function replyForm() {
  const raw = await metaGet(META_MSG_ID);
  const messageId = Number(raw);
  const kind = (await metaGet(META_MSG_KIND)) || 'text';
  return Number.isFinite(messageId) && messageId > 0 ? { messageId, kind } : null;
}

// ── Ответ пользователю ──────────────────────────────────────────────────────

/**
 * Отправить ответ автора обращения.
 *
 * Сообщение идёт ОТ БОТА и цитирует вопрос первой строкой, чтобы человек
 * понял, о чём речь (у него в чате могло не быть истории — история бота
 * у него есть, но цитата спасает при нескольких обращениях).
 *
 * payload: { kind: 'text', text } | { kind: 'photo'|'document', fileId, fileUrl, caption }
 *
 * @returns {Promise<'sent'|'gone'|'error'>} gone — автор заблокировал бота (403).
 */
export async function sendFeedbackReply(feedbackId, payload) {
  const row = await getFeedback(feedbackId);
  if (!row) return 'gone';
  const quote = String(row.text || '').trim().slice(0, 300);
  const head = (quote ? `<blockquote>${escapeHtml(quote)}</blockquote>\n\n` : '')
    + '💬 <b>Ответ разработчика</b>\n\n';
  const opts = { chat_id: row.chatId, parse_mode: 'HTML' };
  try {
    if (payload.kind === 'text') {
      await api.sendMessage({ ...opts, text: head + escapeHtml(String(payload.text || '').slice(0, 3800)) });
    } else {
      const method = payload.kind === 'photo' ? api.sendPhoto : api.sendDocument;
      const input = payload.kind === 'photo' ? payload.fileId : (payload.fileId || payload.fileUrl);
      await method({
        ...opts,
        caption: head + escapeHtml(String(payload.caption || '').slice(0, 900)),
        ...(payload.kind === 'photo' ? { photo: input } : { document: input }),
      });
    }
    return 'sent';
  } catch (e) {
    if (e instanceof BotApiError && e.code === 403) return 'gone';
    console.error('[feedback] reply failed:', e && e.message || e);
    return 'error';
  }
}

// ── Тексты и клавиатуры ─────────────────────────────────────────────────────

export const FEEDBACK_PROMPT_TEXT =
  '✍️ <b>Напишите сообщение здесь</b> — я передам его разработчику.\n\n'
  + 'Опишите, что случилось (ошибка) или что хотите предложить, и отправьте одним текстовым сообщением.';

export const FEEDBACK_PROMPT_KEYBOARD = {
  inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'feedback:cancel' }]],
};

export function feedbackReplyKeyboard(feedbackId) {
  return {
    inline_keyboard: [[{ text: '✏️ Ответить', callback_data: `fb:reply:${feedbackId}` }]],
  };
}

export const FEEDBACK_REPLY_PROMPT =
  '✏️ <b>Напишите ответ</b> — я отправлю его автору обращения.\n\n'
  + 'Можно текстом или картинкой/файлом.';

export const FEEDBACK_REPLY_CANCEL_KEYBOARD = {
  inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'fb:cancel' }]],
};

// ── Ответ владельцу на обращение ───────────────────────────────────────────

// Владелец уже отвечал на это обращение — предупреждаем, но не запрещаем:
// бывает, что ответ ушёл с ошибкой в тексте и его надо повторить.
export const FEEDBACK_ANSWERED_PROMPT =
  '✍️ <b>Обращение уже отвечено.</b> Напишите ещё раз — я отправлю новый ответ.';

function ownerCopyHeader(row, kind) {
  const name = row.authorName || 'без имени';
  const userTag = row.authorUsername ? ` @${row.authorUsername}` : '';
  const what = kind === 'text' ? 'Ответ автору обращения' : 'Ответ автору обращения (вложение)';
  return `👤 <b>${what} #${row.id}</b> (${escapeHtml(name)}${escapeHtml(userTag)}, id=${row.chatId})`;
}

/**
 * Отправить владельцу подтверждение, что ответ набран.
 *
 * Сообщение идёт в тот же чат, где владелец нажал «Ответить» (для личного чата
 * это и есть STATS_CHAT_ID). Для текста — цитата ответа; для вложения —
 * подпись с типом медиа. Кидается при сбое отправки: вызывающий сам решает,
 * считать ли ответ отправленным.
 */
export async function sendOwnerReplyCopy(toChatId, row, payload) {
  const header = ownerCopyHeader(row, payload.kind);
  if (payload.kind === 'text') {
    await api.sendMessage({
      chat_id: toChatId,
      text: `${header}\n\n${escapeHtml(String(payload.text || '').slice(0, 3800))}`,
      parse_mode: 'HTML',
    });
    return;
  }
  const method = payload.kind === 'photo' ? api.sendPhoto : api.sendDocument;
  const input = payload.kind === 'photo' ? payload.fileId : (payload.fileId || payload.fileUrl);
  await method({
    chat_id: toChatId,
    caption: header + (payload.caption ? `\n\n${escapeHtml(payload.caption.slice(0, 800))}` : ''),
    parse_mode: 'HTML',
    ...(payload.kind === 'photo' ? { photo: input } : { document: input }),
  });
}

