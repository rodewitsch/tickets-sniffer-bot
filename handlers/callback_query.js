import { api } from '../api.js';
import { HELP, renderWatchlist, watchlistKeyboard, mainMenuKeyboard } from '../lib/menus.js';
import { listWatchItems, removeWatchItem, deactivateWatchItem, miniAppUrl, miniAppConfigured } from '../lib/watch.js';
import { addWatchItem } from '../lib/watch.js';
import { runCheck } from '../lib/checker.js';

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export default async function (cb) {
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id || cb.from?.id;
  const msgId = cb.message?.message_id;
  const isEditable = !!cb.message && cb.message.chat?.id != null && msgId != null;

  try {
    await api.answerCallbackQuery({ callback_query_id: cb.id });
  } catch { /* уже поздно */ }

  if (data === 'noop') return;

  if (data === 'help') {
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text: HELP, parse_mode: 'HTML' });
    } else {
      await api.sendMessage({ chat_id: chatId, text: HELP, parse_mode: 'HTML' });
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
    return;
  }

  if (data.startsWith('addq:')) {
    const source = data.slice(5);
    const query = unescapeHtml(cb.message?.text || '').trim();
    if (!query) return;
    const res = await addWatchItem({ chatId, kind: 'query', source, query });
    const text = res?.duplicate
      ? `«${query}» уже есть в списке отслеживания.`
      : `✅ Слежу за запросом «${query}» (${source === 'all' ? 'все источники' : source}). Проверю при следующем цикле — или нажмите /check.`;
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text });
    } else {
      await api.sendMessage({ chat_id: chatId, text });
    }
    return;
  }

  if (data === 'chk:now') {
    await api.sendMessage({ chat_id: chatId, text: '🔎 Проверяю источники билетов…' });
    try {
      const res = await runCheck({ force: true });
      await api.sendMessage({
        chat_id: chatId,
        text: res.notified > 0
          ? `✅ Готово: ${res.notified} новое(ых) уведомление(й)!`
          : '✅ Готово: новых билетов не появилось.',
      });
    } catch (e) {
      console.error('forced check failed', e);
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Проверка завершилась с ошибкой, попробуйте позже.' });
    }
    return;
  }

  if (data.startsWith('mute:')) {
    const id = Number(data.slice(5));
    await deactivateWatchItem(id);
    try {
      await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    } catch { /* сообщение могло измениться */ }
    await api.sendMessage({ chat_id: chatId, text: '🔕 Уведомления по этой позиции отключены.' });
    return;
  }
}
