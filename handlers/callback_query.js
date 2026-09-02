import { api } from '../api.js';
import { HELP, helpKeyboard, renderWatchlist, watchlistKeyboard, mainMenuKeyboard } from '../lib/menus.js';
import { listWatchItems, removeWatchItem, deactivateWatchItem, miniAppUrl, miniAppConfigured, SOURCE_LABEL } from '../lib/watch.js';
import { addWatchItem } from '../lib/watch.js';
import { sendFreshReplyKeyboard } from '../lib/reply.js';
import { startFeedback, clearFeedback } from '../lib/feedback.js';

// Промпт режима ввода обращения + кнопка «Отмена» (инлайн на том же сообщении).
const FEEDBACK_PROMPT_TEXT =
  '✍️ <b>Напишите сообщение здесь</b> — я передам его разработчику.\n\n' +
  'Опишите, что случилось (ошибка) или что хотите предложить, и отправьте одним текстовым сообщением.';
function feedbackPromptKeyboard() {
  return { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'feedback:cancel' }]] };
}

export default async function (cb) {
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id || cb.from?.id;
  const msgId = cb.message?.message_id;
  const isEditable = !!cb.message && cb.message.chat?.id != null && msgId != null;

  try {
    await api.answerCallbackQuery({ callback_query_id: cb.id });
  } catch { /* уже поздно */ }

  if (data === 'cancel:add') {
    // Отмена предложения «Добавить <слово> в отслеживание?». Вопрос снят —
    // убираем исходное сообщение с кнопками выбора источника, чтобы кнопки
    // «Везде/Афиша/Ticketpro/BezKassira» не оставались кликабельными.
    // Если удалить не вышло — просто снимем с него клавиатуру.
    if (isEditable) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: msgId });
      } catch {
        try {
          await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
        } catch { /* сообщение могло уже измениться/исчезнуть */ }
      }
    }
    return;
  }

  if (data === 'help') {
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text: HELP, parse_mode: 'HTML', reply_markup: helpKeyboard() });
    } else {
      await api.sendMessage({ chat_id: chatId, text: HELP, parse_mode: 'HTML', reply_markup: helpKeyboard() });
    }
    return;
  }

  if (data === 'feedback:start') {
    // Включаем режим ввода обращения: следующее текстовое сообщение бот
    // отправит владельцу (см. handlers/message.js), а не предложит как ключевое слово.
    startFeedback(chatId);
    const text = FEEDBACK_PROMPT_TEXT;
    const kb = feedbackPromptKeyboard();
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  if (data === 'feedback:cancel') {
    clearFeedback(chatId);
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text: 'Отменено 🙂', parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    } else {
      await api.sendMessage({ chat_id: chatId, text: 'Отменено 🙂 Если понадобится помощь — напишите /help.' });
    }
    return;
  }

  if (data === 'wl:list') {
    const items = await listWatchItems(chatId);
    const text = renderWatchlist(items);
    const kb = items.length ? watchlistKeyboard(items) : mainMenuKeyboard(miniAppUrl(items), miniAppConfigured());
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  if (data.startsWith('del:')) {
    const id = Number(data.slice(4));
    await removeWatchItem(chatId, id);
    const items = await listWatchItems(chatId);
    const text = renderWatchlist(items);
    const kb = items.length ? watchlistKeyboard(items) : undefined;
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    // Обновляем reply-клавиатуру (кнопка Mini App) — свежий снапшот списка.
    await sendFreshReplyKeyboard(chatId, '🗑 Позиция удалена из списка отслеживания.');
    return;
  }

  if (data.startsWith('addq:')) {
    // Формат: addq:<source>:<base64url(query)> — так исходное слово не теряется.
    const parts = data.split(':');
    const source = parts[1];
    let query = '';
    try {
      query = Buffer.from(parts.slice(2).join(':'), 'base64url').toString('utf8').trim();
    } catch { query = ''; }
    if (!query) return;
    const res = await addWatchItem({ chatId, kind: 'query', source, query });
    const text = res?.duplicate
      ? `«${query}» уже есть в списке отслеживания.`
      : `✅ Слежу за запросом «${query}» (${SOURCE_LABEL[source] || source}).`;
    if (isEditable) {
      // Убираем исходное сообщение с кнопками выбора источника — вопрос решён,
      // чтобы кнопки «Везде/Афиша/Ticketpro/Отмена» не оставались кликабельными.
      // Если удалить не вышло — просто снимем с него клавиатуру.
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: msgId });
      } catch {
        try {
          await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
        } catch { /* сообщение могло уже измениться/исчезнуть */ }
      }
    }
    // Единственное подтверждение — сообщение со свежей reply-клавиатурой
    // (несёт свежий снапшот списка для Mini App). Текст выше не дублируем.
    await sendFreshReplyKeyboard(chatId, text);
    return;
  }

  if (data.startsWith('mute:')) {
    const id = Number(data.slice(5));
    await deactivateWatchItem(chatId, id);
    try {
      await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    } catch { /* сообщение могло измениться */ }
    const text = '🔕 Уведомления по этой позиции отключены.';
    // Единственное подтверждение — сообщение со свежей reply-клавиатурой
    // (свежий снапшот списка Mini App). Текст отдельным sendMessage не дублируем.
    await sendFreshReplyKeyboard(chatId, text);
    return;
  }
}
