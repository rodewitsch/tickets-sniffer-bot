import { api } from '../api.js';
import { db } from '../db.js';
import { users } from '../schema.js';
import { sql } from '../db.js';
import {
  WELCOME, HELP,
  mainMenuKeyboard, proposeAddKeyboard, proposeAddText,
  renderWatchlist, watchlistKeyboard,
} from '../lib/menus.js';
import { listWatchItems, miniAppUrl, miniAppConfigured } from '../lib/watch.js';
import { handleWebAppData } from '../lib/webapp.js';
import { runCheck } from '../lib/checker.js';

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
      reply_markup: mainMenuKeyboard(miniAppUrl(items), miniAppConfigured()),
    });
    return;
  }

  if (text === '/help') {
    await api.sendMessage({ chat_id: chatId, text: HELP, parse_mode: 'HTML' });
    return;
  }

  if (text === '/list') {
    const items = await listWatchItems(chatId);
    await api.sendMessage({
      chat_id: chatId,
      text: renderWatchlist(items),
      parse_mode: 'HTML',
      reply_markup: items.length ? watchlistKeyboard(items) : undefined,
    });
    return;
  }

  if (text === '/check') {
    await api.sendMessage({ chat_id: chatId, text: '🔎 Проверяю источники билетов…' });
    try {
      const res = await runCheck({ force: true });
      await api.sendMessage({
        chat_id: chatId,
        text: res.notified > 0
          ? `✅ Проверка завершена: ${res.notified} новое(ых) уведомление(й)!`
          : '✅ Проверка завершена: новых билетов не появилось.',
      });
    } catch (e) {
      console.error('forced check failed', e);
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Проверка завершилась с ошибкой, попробуйте позже.' });
    }
    return;
  }

  if (text.startsWith('/')) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Не знаю такую команду. Доступны: /start, /list, /check, /help',
    });
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

  // «Попутная» фоновая проверка (с внутренним интервалом, дешёвая в большинстве вызовов).
  try {
    await runCheck({});
  } catch (e) {
    console.warn('piggyback check failed:', e.message);
  }
}
