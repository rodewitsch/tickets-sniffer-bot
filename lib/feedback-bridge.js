// Владелец отвечает на обращение пользователя.
//
// Раньше обращение из «✍️ Сообщить об ошибке / пожелание» приходило владельцу
// простым сообщением от бота — ответить на него было некому. Теперь обращение
// сохраняется в `feedback` и приходит с кнопкой «✏️ Ответить» (см.
// lib/feedback.js и handlers/callback_query.js). Нажатие включает режим ответа, и
// следующий апдейт от владельца (текст или медиа) обрабатывается ЗДЕСЬ, до
// обычной логики.
//
// Кто «владелец»: чат, куда бот пересылает обращения — STATS_CHAT_ID.
import { api } from '../api.js';
import { STATS_CHAT_ID } from './config.js';
import {
  replySession, clearReply, getFeedback, markFeedbackAnswered,
  sendFeedbackReply, sendOwnerReplyCopy,
} from '../lib/feedback.js';
import { sendFreshReplyKeyboard } from './reply.js';

// Данные вложения из апдейта. Фото Telegram отдаёт массивом размеров — берём
// последний (самый большой).
function extractMedia(message) {
  const photos = message.photo;
  if (Array.isArray(photos) && photos.length) {
    return { kind: 'photo', fileId: photos[photos.length - 1].file_id };
  }
  const doc = message.document;
  if (doc && doc.file_id) return { kind: 'document', fileId: doc.file_id };
  return null;
}

/**
 * Обработать сообщение владельца в режиме ответа.
 *
 * @returns {Promise<boolean>} true — сообщение было ответом (и обработано),
 *   false — режима ответа нет, апдейт должен пойти по обычному пути.
 */
export default async function handleOwnerReply(message) {
  const chatId = message.chat?.id;
  if (!chatId || chatId !== STATS_CHAT_ID) return false;

  const feedbackId = await replySession();
  if (!feedbackId) return false;

  // Команду владельца ответом не считаем: /stats или /help в режиме ответа
  // должны работать привычно, а не уйти человеку текстом.
  if (message.text && message.text.startsWith('/')) {
    await clearReply();
    return false;
  }

  const text = (message.text || message.caption || '').trim();
  const media = extractMedia(message);
  if (!media && !text) return false; // стикер/голосовое: не ответ, пусть решает обычный путь

  const row = await getFeedback(feedbackId);
  if (!row) {
    await clearReply();
    await api.sendMessage({ chat_id: chatId, text: '⚠️ Обращение не найдено (возможно, очень старая запись).' });
    return true;
  }

  const payload = media
    ? { ...media, caption: text }
    : { kind: 'text', text };

  // Черновик владельцу: что именно уйдёт человеку и кому.
  try {
    await sendOwnerReplyCopy(chatId, row, payload);
  } catch (e) {
    console.error('[feedback] owner copy failed:', e && e.message || e);
  }

  const result = await sendFeedbackReply(feedbackId, payload);
  const mediaLabel = media ? (media.kind === 'photo' ? '🖼 Фото' : '📎 Файл') : '';
  await markFeedbackAnswered(feedbackId, {
    replyText: [mediaLabel, text].filter(Boolean).join(' · ').trim(),
  });
  await clearReply();

  if (result === 'sent') {
    await sendFreshReplyKeyboard(chatId, `✅ Ответ отправлен в чат ${row.chatId}.`);
  } else if (result === 'gone') {
    await sendFreshReplyKeyboard(chatId, `🚪 Чат ${row.chatId} недоступен (бот заблокирован или чат удалён).`);
  } else {
    await sendFreshReplyKeyboard(chatId, `⚠️ Не удалось отправить ответ автору обращения #${row.id}.`);
  }
  return true;
}
