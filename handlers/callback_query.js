import { api } from '../api.js';
import { HELP, helpKeyboard, renderWatchlist, mainMenuKeyboard, mainReplyKeyboard, NO_LINK_PREVIEW, disableConfirmText, disableConfirmKeyboard, disabledText, renderMutedEvents, mutedEventsKeyboard, notificationKey, CALLBACK_DATA_TRUNCATED } from '../lib/menus.js';
import { listWatchItems, removeWatchItem, deactivateWatchItem, getWatchItem, miniAppUrl, miniAppConfigured, SOURCE_LABEL, deleteAllUserData, muteEvent, listMutedEvents, unmuteEvent, unmuteAllEvents } from '../lib/watch.js';
import { addWatchItem } from '../lib/watch.js';
import { sendFreshReplyKeyboard } from '../lib/reply.js';
import { startFeedback, clearFeedback } from '../lib/feedback.js';
import { escapeHtml, stripTags } from '../lib/util.js';

// Промпт режима ввода обращения + кнопка «Отмена» (инлайн на том же сообщении).
const FEEDBACK_PROMPT_TEXT =
  '✍️ <b>Напишите сообщение здесь</b> — я передам его разработчику.\n\n' +
  'Опишите, что случилось (ошибка) или что хотите предложить, и отправьте одним текстовым сообщением.';
function feedbackPromptKeyboard() {
  return { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'feedback:cancel' }]] };
}

// Название события из карточки уведомления — только для показа в списке
// заглушённого («что я выключил»). Заголовок карточки идёт третьей строкой
// после «🎫 Появились билеты!» и пустой строки (см. ticketCaption).
//
// Здесь НЕТ санитайзинга с последующим разэкранированием. Раньше было так:
//   candidate.replace(/<\/?[^>]+>/g, '')            ← «удалить теги»
//     .replace(/&lt;/g, '<') … .replace(/&#39;/g, "'")
// Это два бага сразу (CodeQL: js/incomplete-multi-character-sanitization и
// js/double-escaping):
//   • после удаления тегов строка СНОВА получала `<` из `&lt;`, то есть
//     «очищенная» строка могла содержать `<script` и HTML вообще;
//   • `&amp;lt;` превращался в `&lt;`, а затем в `<` — двойная расшифровка.
// Но эта строка никогда не уходит как HTML: получатель кладёт caption в
// `text` сообщения с parse_mode:'HTML' и сам вызывает escapeHtml (см.
// renderMutedEvents в lib/menus.js), поэтому возвращаем ЧИСТЫЙ ТЕКСТ:
// убираем теги (stripTags — до неподвижной точки) и расшифровываем
// HTML-сущности ОДИН раз. `<` остаётся символом и будет экранирован позже.
const CAPTION_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};
function decodeOnce(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) return safeCodePoint(parseInt(key.slice(2), 16)) ?? m;
    if (key.startsWith('#')) return safeCodePoint(parseInt(key.slice(1), 10)) ?? m;
    return CAPTION_ENTITIES[key] ?? m;
  });
}
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
  // Управляющие символы в подпись не нужны: они только портят вывод.
  if (code < 0x20 && code !== 0x09 && code !== 0x0a) return null;
  try { return String.fromCodePoint(code); } catch { return null; }
}

// Метка «значение в кнопку не влезло — возьми его из текста сообщения»
// (см. ticketKeyboard / proposeAddKeyboard в lib/menus.js). «!» не входит в
// base64url, поэтому метку нельзя спутать с настоящим ключом.
const TRUNCATED_KEY = CALLBACK_DATA_TRUNCATED;

// Ключ антидубля, восстановленный из подписи карточки.
//
// Зачем: callback_data ограничен 64 байтами, а ключ содержит нормализованное
// НАЗВАНИЕ события (у «Представление у Ёлки … Белоснежка …» он весил 256 байт
// в base64url). Такая кнопка ломала отправку ВСЕГО сообщения (400
// BUTTON_DATA_INVALID), поэтому длинные ключи в кнопку не кладутся.
//
// Карточка содержит то же, из чего ключ собран: 2-я строка — название
// (notificationKey нормализует его через normText), а дата — в строке «📅 …»,
// которая в точности равна events.dateText, то есть «ДД.ММ.ГГГГ ЧЧ:ММ».
// День считаем в UTC из этой даты. Если что-то не разобралось — возвращаем
// null: лучше не заглушить, чем заглушить не то событие.
function dedupeKeyFromCard(cardText) {
  const lines = String(cardText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  // ['🎫 Появились билеты!', '<b>Название</b>', '📅 …', '📍 …', '', '<i>источник</i>']
  const titleLine = lines[1].replace(/^<b>|<\/b>$/g, '');
  const title = decodeOnce(stripTags(titleLine)).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const dateLine = lines.find((l) => l.startsWith('📅')) || '';
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(dateLine);
  if (!m) return null;
  const [, dd, mo, yy, hh = '00', mi = '00'] = m;
  // Беларусь = UTC+3, сутки считаются по UTC — та же арифметика, что в
  // notificationKey (Math.floor(startsAt / 86400)). Карточка показывает
  // локальное время, поэтому переводим обратно в UTC.
  const utcMs = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi)) - 3 * 3600 * 1000;
  return notificationKey({ title, startsAt: Math.floor(utcMs / 1000) });
}

function titleFromNotification(cb) {
  const caption = cb.message?.caption || cb.message?.text || '';
  const lines = caption.split('\n').map((l) => l.trim()).filter(Boolean);
  // ['🎫 Появились билеты!', '<b>Название</b>', '📅 …', '📍 …'] — берём вторую.
  const candidate = lines[1] || '';
  const clean = decodeOnce(stripTags(candidate)).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 200) : null;
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
    // Кнопок удаления в списке больше нет: отписка — ссылкой 🔕 у каждой позиции,
    // а превью ссылок (страницы событий) отключено, чтобы не разворачивалась карточка.
    const kb = items.length ? undefined : mainMenuKeyboard(miniAppUrl(items), miniAppConfigured());
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb, link_preview_options: NO_LINK_PREVIEW });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb, link_preview_options: NO_LINK_PREVIEW });
    }
    return;
  }

  // Легаси-ветка: старые сообщения списка (до перехода на ссылки) ещё живут
  // в истории чатов с кнопками «❌ <название>». Оставляем, чтобы они работали.
  if (data.startsWith('del:')) {
    const id = Number(data.slice(4));
    await removeWatchItem(chatId, id);
    const items = await listWatchItems(chatId);
    const text = renderWatchlist(items);
    const kb = items.length ? undefined : mainMenuKeyboard(miniAppUrl(items), miniAppConfigured());
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb, link_preview_options: NO_LINK_PREVIEW });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb, link_preview_options: NO_LINK_PREVIEW });
    }
    // Обновляем reply-клавиатуру (кнопка Mini App) — свежий снапшот списка.
    await sendFreshReplyKeyboard(chatId, '🗑 Позиция удалена из списка отслеживания.');
    return;
  }

  // Подтверждение отписки по ссылке из списка: unsub:yes:<id> | unsub:no:<id>.
  if (data.startsWith('unsub:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = Number(parts[2]);
    // Владельца проверяем по chatId (FK в SQLite нет): чужая ссылка даст null.
    const item = await getWatchItem(chatId, id);
    const name = escapeHtml(item ? (item.title || item.query) : '');
    if (action === 'no') {
      const text = item
        ? `👍 Оставляю «${name}» в списке.`
        : '👍 Ничего не меняю.';
      if (isEditable) {
        await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
      } else {
        await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
      }
      return;
    }
    if (!item) {
      const text = '🤔 Эта позиция уже не отслеживается — возможно, вы отписались раньше.';
      if (isEditable) {
        await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
      } else {
        await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
      }
      return;
    }
    await removeWatchItem(chatId, id);
    const text = `🔕 Отписано: «${name}».`;
    // Промпт с кнопками убираем: правка его тем же текстом + отдельное сообщение
    // ниже давали два одинаковых «Отписано» в чате. Если удалить не вышло — снимаем
    // с промпта клавиатуру, чтобы кнопки ✅/↩️ не оставались кликабельными.
    if (isEditable) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: msgId });
      } catch {
        try {
          await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
        } catch { /* сообщение могло исчезнуть */ }
      }
    }
    // Единственное подтверждение — сообщение со свежей reply-клавиатурой
    // (несёт свежий снапшот списка для Mini App), как у del:/mute:.
    await sendFreshReplyKeyboard(chatId, text);
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
    // Метка «запрос в кнопку не влез — он есть в тексте сообщения»
    // (см. proposeAddKeyboard в lib/menus.js). Без этого длинный запрос давал
    // те же 400 BUTTON_DATA_INVALID на всё сообщение, что и у «Больше не
    // уведомлять»: кнопки выбора источника просто не отправлялись.
    if (query === TRUNCATED_KEY) {
      const msgText = cb.message?.text || '';
      const m = /Добавить «([\s\S]*)» в отслеживание/.exec(msgText);
      query = m ? decodeOnce(stripTags(m[1])).trim() : '';
    }
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

  // «🔕 Больше не уведомлять» — глушим КОНКРЕТНОЕ событие, а не подписку.
  //
  // Формат: mute:<watchId>:<base64url(dedupeKey)>. Раньше здесь деактивировалась
  // вся позиция, и нажатие под одним спектаклем выключало всё слово «театр» —
  // хотя человеку театр по-прежнему интересен, не нужен был именно этот спектакль.
  // Старые сообщения в чатах несут голый `mute:<id>` без ключа события: для них
  // сохраняем прежнее поведение (деактивация позиции), чтобы кнопка не «зависла»
  // и не начала глушить всё подряд.
  if (data.startsWith('mute:')) {
    const parts = data.split(':');
    const watchId = Number(parts[1]);
    let keyB64 = parts[2];
    // Длинный ключ в кнопку не влезает (Telegram: 64 байта на callback_data) —
    // тогда кнопка несёт `mute:<id>:!` («!» = восстановить ключ из карточки).
    // Обычный base64url-ключ «!» содержать не может, так что метка однозначна.
    if (keyB64 === TRUNCATED_KEY) keyB64 = '';
    let dedupeKey = '';
    if (keyB64) {
      try {
        dedupeKey = Buffer.from(keyB64, 'base64url').toString('utf8');
      } catch { dedupeKey = ''; }
    }

    // Владельца проверяем по chatId (FK в SQLite нет): чужая кнопка ничего не сделает.
    const item = Number.isFinite(watchId) ? await getWatchItem(chatId, watchId) : null;

    // Ключ не пришёл в кнопке (длинное название) — восстанавливаем из карточки:
    // заголовок и дата в ней те же, из которых notificationKey и строился.
    // Редактировать карточку может только сам бот, поэтому её текст — наши данные.
    if (!dedupeKey && data === `mute:${watchId}:${TRUNCATED_KEY}`) {
      try {
        const fromCard = dedupeKeyFromCard(cb.message?.caption || cb.message?.text || '');
        if (fromCard) dedupeKey = fromCard;
      } catch { dedupeKey = ''; }
    }

    if (dedupeKey) {
      // Владелец позиции должен совпадать с нажавшим: иначе по чужой карточке
      // можно было бы заглушить событие у себя (безобидно) или выдать себя за
      // другого. Позиция могла быть уже удалена — тогда ориентируемся только на
      // chatId самого нажатия, он и так наш.
      const owner = item ? item.chatId : chatId;
      if (owner !== chatId) return;
      await muteEvent({ chatId, dedupeKey, title: titleFromNotification(cb), dateText: null });
      try {
        await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      } catch { /* сообщение могло измениться */ }
      const text =
        '🔕 Больше не буду присылать уведомления про это событие.\n' +
        '<i>Ваши остальные подписки (в том числе по этому же слову) продолжают работать.</i>';
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
      return;
    }

    // Легаси-формат `mute:<id>` из сообщений, отправленных до этого изменения.
    await deactivateWatchItem(chatId, watchId);
    try {
      await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    } catch { /* сообщение могло измениться */ }
    const text = '🔕 Уведомления по этой позиции отключены.';
    // Единственное подтверждение — сообщение со свежей reply-клавиатурой
    // (свежий снапшот списка Mini App). Текст отдельным sendMessage не дублируем.
    await sendFreshReplyKeyboard(chatId, text);
    return;
  }

  // ── «🔕 Заглушённые события»: список и снятие заглушек ─────────────────────
  // Обратный путь к кнопке «Больше не уведомлять»: без него человек, заглушивший
  // спектакль, не может вернуть его, не отключая подписку на слово целиком.
  if (data === 'muted:list') {
    const rows = await listMutedEvents(chatId);
    const text = renderMutedEvents(rows);
    const kb = mutedEventsKeyboard(rows);
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  if (data === 'muted:clear') {
    await unmuteAllEvents(chatId);
    const text = '🔔 Готово: снова буду присылать уведомления про все ранее заглушённые события.';
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📋 Мой список', callback_data: 'wl:list' }]] } });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
    }
    return;
  }

  if (data.startsWith('muted:un:')) {
    const id = Number(data.slice('muted:un:'.length));
    // Владельца проверяет сам unmuteEvent (условие по chatId), чужой id безопасен.
    const before = await listMutedEvents(chatId);
    const target = before.find((r) => Number(r.id) === id);
    await unmuteEvent(chatId, id);
    const rows = await listMutedEvents(chatId);
    const name = target && target.title ? `«${escapeHtml(target.title)}»` : 'это событие';
    const text = target
      ? `🔔 Снова слежу: ${name}.${rows.length ? '' : '\n\nЗаглушённых событий больше нет.'}`
      : '🤔 Этого события нет в списке заглушённых — возможно, уже включено.';
    const kb = rows.length ? mutedEventsKeyboard(rows) : { inline_keyboard: [[{ text: '📋 Мой список', callback_data: 'wl:list' }]] };
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  // ── «Отключить бота»: полное удаление данных пользователя ──────────────────
  // Три шага: account:disable → показываем подтверждение со счётчиком позиций;
  // :yes → удаляем и убираем клавиатуру; :no → возвращаем обычные кнопки.
  // Удаление необратимо, поэтому между кнопкой и удалением всегда стоит вопрос.
  if (data === 'account:disable') {
    const items = await listWatchItems(chatId);
    const text = disableConfirmText(items.length);
    const kb = disableConfirmKeyboard();
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  if (data === 'account:disable:no') {
    // Ничего не удаляем. Возвращаем обычный экран, чтобы в чате не остался
    // «страшный» вопрос с кнопкой удаления.
    const items = await listWatchItems(chatId);
    const text = '👍 Хорошо, ничего не удаляю. Продолжаю следить за билетами.';
    const kb = mainReplyKeyboard(miniAppUrl(items), miniAppConfigured());
    if (isEditable) {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
      await api.sendMessage({ chat_id: chatId, text: 'Кнопки на месте 👇', reply_markup: kb });
    } else {
      await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
    }
    return;
  }

  if (data === 'account:disable:yes') {
    const counts = await deleteAllUserData(chatId);
    console.log(`[account] chat ${chatId} отключил бота: удалено позиций ${counts.watchItems}, очередки площадок ${counts.venueQueue}, уведомлений ${counts.notifications}`);
    // Сначала снимаем кнопки со «страшного» вопроса (если сообщение можно править),
    // затем убираем reply-клавиатуру: иначе «Мой список»/«Отключить бота» останутся
    // под полем ввода у человека, который только что попросил всё стереть.
    if (isEditable) {
      try {
        await api.deleteMessage({ chat_id: chatId, message_id: msgId });
      } catch {
        try {
          await api.editMessageReplyMarkup({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
        } catch { /* сообщение могло исчезнуть */ }
      }
    }
    await api.sendMessage({
      chat_id: chatId,
      text: disabledText(counts),
      parse_mode: 'HTML',
      // Пустая reply-клавиатура: убирает постоянные кнопки под полем ввода.
      reply_markup: { remove_keyboard: true },
    });
    return;
  }
}
