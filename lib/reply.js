// Общий хелпер: шлёт сообщение с актуальной reply-клавиатурой бота.
// Reply-клавиатура содержит кнопку открытия Mini App «🔍 Найти и следить», URL
// которой несёт снапшот списка (miniAppUrl). Чтобы Mini App при повторном
// открытии показывал свежий список, клавиатуру нужно переотправлять после ЛЮБОЙ
// операции с позициями отслеживания — не только из Mini App (webapp.js), но и
// из чата (handlers/callback_query.js): del:, addq:, mute:.
import { api } from '../api.js';
import { mainReplyKeyboard } from './menus.js';
import { listWatchItems, miniAppUrl, miniAppConfigured } from './watch.js';

// Отправляет сообщение text с актуальной reply-клавиатурой (свежий снапшот списка).
export async function sendFreshReplyKeyboard(chatId, text) {
  if (!chatId) return;
  const items = await listWatchItems(chatId);
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: mainReplyKeyboard(miniAppUrl(items), miniAppConfigured()),
  });
}
