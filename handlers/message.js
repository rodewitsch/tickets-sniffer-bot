import { api } from '../api.js';
import { db } from '../db.js';
import { users } from '../schema.js';
import { sql } from '../db.js';
import {
  WELCOME, HELP, helpKeyboard,
  mainMenuKeyboard, mainReplyKeyboard, proposeAddKeyboard, proposeAddText,
  renderWatchlist, unsubConfirmText, unsubConfirmKeyboard, NO_LINK_PREVIEW,
  disableConfirmText, disableConfirmKeyboard, DISABLE_BUTTON,
} from '../lib/menus.js';
import { listWatchItems, miniAppUrl, miniAppConfigured, getWatchItem } from '../lib/watch.js';
import { handleWebAppData } from '../lib/webapp.js';
import { sendStatsReport } from '../lib/stats.js';
import { sendFreshReplyKeyboard } from '../lib/reply.js';
import { STATS_CHAT_ID } from '../lib/config.js';
import { feedbackSession, clearFeedback } from '../lib/feedback.js';
import { escapeHtml } from '../lib/util.js';

export default async function (message) {
  const chat = message.chat;
  const chatId = chat.id;

  // Регистрация и отметка активности — ДО ветвления на Mini App.
  //
  // Раньше upsert стоял ниже проверки web_app_data, и всё, что пользователь
  // делал в Mini App (добавление и удаление позиций, поиск), выходило раньше
  // по коду: lastSeenAt не обновлялся вовсе. В проде это выглядело как
  // «активных за 24 ч — 1» при 49 пользователях и 22 живых позициях.
  //
  // insert + onConflictDoUpdate, а не onConflictDoNothing: базовая строка (и
  // users.created_at) создаётся один раз, дальше обновляется только lastSeenAt.
  // Если юзера удалило автоудаление при 403, он заводится заново — блокировка
  // после этого уже не действует.
  await db
    .insert(users)
    .values({
      chatId,
      username: message.from?.username || chat.username || null,
      firstName: message.from?.first_name || chat.first_name || chat.title || null,
    })
    .onConflictDoUpdate({
      target: users.chatId,
      // blockedAt снимаем здесь же: обращение к боту = пользователь вернулся.
      // CASE, а не просто NULL: колонка не должна меняться на каждом апдейте
      // (иначе перезаписываем строку зря у всех, кто и так не блокирован).
      set: {
        lastSeenAt: sql`unixepoch()`,
        blockedAt: sql`CASE WHEN ${users.blockedAt} IS NOT NULL THEN NULL ELSE ${users.blockedAt} END`,
      },
    })
    .run();

  // Данные из Mini App приходят как поле Message.web_app_data.
  if (message.web_app_data && message.web_app_data.data) {
    console.log('[webapp] got web_app_data from chat', chatId, 'button:', message.web_app_data.button_text, 'len:', message.web_app_data.data.length);
    await handleWebAppData(chatId, message.web_app_data.data);
    return;
  }

  const text = (message.text || '').trim();

  if (!text) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Я понимаю текстовые сообщения и команды 🙂 Наберите /help для справки.',
    });
    return;
  }

  if (text === '/start' || text.startsWith('/start ')) {
    // Диплинк из сообщения «Мой список»: /start unsub_<id> — отписка от позиции.
    // Позицию ищем по chatId, так что чужая (пересланная) ссылка ничего не сломает.
    const payload = text.slice('/start'.length).trim();
    const byLink = payload.match(/^unsub_(\d+)$/);
    if (byLink) {
      const item = await getWatchItem(chatId, Number(byLink[1]));
      if (!item) {
        await api.sendMessage({
          chat_id: chatId,
          text: '🤔 Эта позиция уже не отслеживается — возможно, вы отписались раньше.\nПришлите /list, чтобы посмотреть актуальный список.',
        });
        return;
      }
      await api.sendMessage({
        chat_id: chatId,
        text: unsubConfirmText(item),
        parse_mode: 'HTML',
        reply_markup: unsubConfirmKeyboard(item.id),
      });
      return;
    }
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
      // Кнопок удаления больше нет (отписка — ссылкой 🔕 у позиции), поэтому
      // для непустого списка клавиатуру не шлём, а превью ссылок отключаем.
      link_preview_options: NO_LINK_PREVIEW,
      reply_markup: items.length ? undefined : mainMenuKeyboard(miniAppUrl(items), miniAppConfigured()),
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

  // «🚪 Отключить бота» — кнопка reply-клавиатуры (текст) и команда /stop.
  // Само удаление НЕ делаем здесь: показываем подтверждение, а стираем данные
  // только по нажатию «Да, удалить всё» (account:disable:yes). Так случайный тап
  // по кнопке не уничтожает подписки.
  if (text === DISABLE_BUTTON || text === '/stop' || text === '/unsubscribe') {
    const items = await listWatchItems(chatId);
    await api.sendMessage({
      chat_id: chatId,
      text: disableConfirmText(items.length),
      parse_mode: 'HTML',
      reply_markup: disableConfirmKeyboard(),
    });
    return;
  }

  if (text.startsWith('/')) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Не знаю такую команду. Доступны: /start, /list, /stats, /help, /stop',
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
