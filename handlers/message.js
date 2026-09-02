import { api } from '../api.js';
import { db } from '../db.js';
import { users } from '../schema.js';
import { sql } from '../db.js';
import {
  WELCOME, HELP, helpKeyboard,
  mainMenuKeyboard, mainReplyKeyboard, proposeAddKeyboard, proposeAddText,
  renderWatchlist, watchlistKeyboard,
} from '../lib/menus.js';
import { listWatchItems, miniAppUrl, miniAppConfigured } from '../lib/watch.js';
import { handleWebAppData } from '../lib/webapp.js';
import { sendStatsReport } from '../lib/stats.js';
import { sendFreshReplyKeyboard } from '../lib/reply.js';
import { STATS_CHAT_ID } from '../lib/config.js';
import { feedbackSession, clearFeedback } from '../lib/feedback.js';
import { escapeHtml } from '../lib/util.js';

export default async function (message) {
  const chat = message.chat;
  const chatId = chat.id;

  // Данные из Mini App приходят как поле Message.web_app_data.
  if (message.web_app_data && message.web_app_data.data) {
    console.log('[webapp] got web_app_data from chat', chatId, 'button:', message.web_app_data.button_text, 'len:', message.web_app_data.data.length);
    await handleWebAppData(chatId, message.web_app_data.data);
    return;
  }

  await db
    .insert(users)
    .values({
      chatId,
      username: message.from?.username || chat.username || null,
      firstName: message.from?.first_name || chat.first_name || chat.title || null,
    })
    .onConflictDoUpdate({
      target: users.chatId,
      set: { lastSeenAt: sql`unixepoch()` },
    })
    .run();

  const text = (message.text || '').trim();

  if (!text) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Я понимаю текстовые сообщения и команды 🙂 Наберите /help для справки.',
    });
    return;
  }

  if (text === '/start') {
    const items = await listWatchItems(chatId);
    await api.sendMessage({
      chat_id: chatId,
      text: WELCOME,
      parse_mode: 'HTML',
      reply_markup: mainReplyKeyboard(miniAppUrl(items), miniAppConfigured()),
    });
    return;
  }

  if (text === '/help' || text === 'ℹ️ Помощь') {
    await api.sendMessage({ chat_id: chatId, text: HELP, parse_mode: 'HTML', reply_markup: helpKeyboard() });
    return;
  }

  if (text === '/list' || text === '📋 Мой список') {
    const items = await listWatchItems(chatId);
    await api.sendMessage({
      chat_id: chatId,
      text: renderWatchlist(items),
      parse_mode: 'HTML',
      reply_markup: items.length ? watchlistKeyboard(items) : undefined,
    });
    return;
  }

  if (text === '/stats') {
    if (chatId !== STATS_CHAT_ID) {
      await api.sendMessage({ chat_id: chatId, text: 'Команда доступна только владельцу.' });
      return;
    }
    try {
      await sendStatsReport(chatId);
    } catch (e) {
      console.error('stats report failed:', e && e.message || e);
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Не удалось собрать статистику, попробуйте позже.' });
    }
    return;
  }

  if (text.startsWith('/')) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Не знаю такую команду. Доступны: /start, /list, /stats, /help',
    });
    return;
  }

  // Режим «написать владельцу» из Помощи: следующее текстовое сообщение — это
  // обращение (ошибка/пожелание), а не ключевое слово для отслеживания.
  // Пересылаем его владельцу (STATS_CHAT_ID) с данными отправителя.
  if (feedbackSession(chatId)) {
    clearFeedback(chatId);
    const from = message.from || {};
    const name = from.first_name || message.chat?.title || '?';
    const userTag = from.username ? `@${from.username}` : '';
    const header = `✍️ <b>Обращение</b>\nОт: ${escapeHtml(name)} ${userTag ? escapeHtml(userTag) : ''} (id=${chatId})\n\n`;
    try {
      await api.sendMessage({
        chat_id: STATS_CHAT_ID,
        text: header + escapeHtml(text.slice(0, 3000)),
        parse_mode: 'HTML',
      });
      await sendFreshReplyKeyboard(chatId, '✅ Спасибо! Я передал ваше сообщение разработчику.');
    } catch (e) {
      console.error('feedback forward failed:', e && e.message || e);
      await api.sendMessage({
        chat_id: chatId,
        text: '⚠️ Не удалось отправить сообщение. Попробуйте ещё раз позже или напишите /feedback.',
      });
    }
    return;
  }

  // Произвольный текст → предложение добавить как ключевое слово.
  const kw = text.slice(0, 200);
  await api.sendMessage({
    chat_id: chatId,
    text: proposeAddText(kw),
    parse_mode: 'HTML',
    reply_markup: proposeAddKeyboard(kw),
  });
}
