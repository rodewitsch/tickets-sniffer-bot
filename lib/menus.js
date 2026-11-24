// Тексты и клавиатуры бота.
import { escapeHtml, pluralRu, normText } from './util.js';
import { KIND_LABEL, SOURCE_LABEL } from './watch.js';
import { cityLabel } from './cities.js';
import { BOT_LINK_BASE } from './config.js';

// Telegram разрешает не больше 64 БАЙТ в callback_data. Превышение — не «кнопка
// не сработает», а 400 «BUTTON_DATA_INVALID» на всё сообщение: карточка не
// отправлялась, позиция падала исключением (в проде так «сломались» две
// площадки — 52 и 61 падение подряд). Считаем в байтах, а не в символах:
// UTF-8 кириллица занимает 2 байта.
export const CALLBACK_DATA_MAX = 64;

// Метка «в кнопку влезло не всё — возьми остальное из текста сообщения».
// «!» в base64url не встречается, поэтому метку нельзя спутать с настоящим
// значением; и в `mute:<id>:!`, и в `addq:<source>:!` она однозначна.
export const CALLBACK_DATA_TRUNCATED = '!';

// ── День события (номер суток UTC) ─────────────────────────────────────────
//
// Ключ антидубля и заглушки содержит ДЕНЬ события, поэтому день должен
// считаться ОДИНАКОВО в двух местах:
//   • в чекере (notificationKey по событию из источника/базы) — есть startsAt,
//     а для «афиши» часто только dateText (готовой строкой, локальное время);
//   • в обработчике кнопки (dedupeKeyFromCard) — из карточки, где есть только
//     текст «📅 ДД.ММ.ГГГГ ЧЧ:ММ».
//
// Раньше день брался ТОЛЬКО из startsAt, а при его отсутствии — 'nodate'. Беда
// в том, что у событий «афиши» из расписания startsAt бывал пустым, а dateText
// был (см. fetchAfishaCityAvailability), и ключ уведомления получался
// `ev:<название>:nodate`. Кнопка же восстанавливала день из карточки — то есть в
// ключ заглушки попадал настоящий день, и isMuted() его не находил: событие
// приходило снова (в проде — «Плетёный муж» и другие события с длинным
// названием, у которых кнопка несёт метку «!»).
//
// Теперь день считается из startsAt, А ЕСЛИ ЕГО НЕТ — из dateText. Часовой
// пояс у dateText всегда Беларусь (UTC+3): так его строят все источники
// (afishaSessionDateText, formatDateRu + parseDate, ticketpro).
const DATE_TEXT_RE = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/;
const BELARUS_OFFSET_MS = 3 * 3600 * 1000;

/** День (номер суток UTC) из текста даты «ДД.ММ.ГГГГ [ЧЧ:ММ]» (время — UTC+3). */
export function dayFromDateText(dateText) {
  const m = DATE_TEXT_RE.exec(String(dateText || ''));
  if (!m) return null;
  const [, dd, mo, yy, hh = '00', mi = '00'] = m;
  const localMs = Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi));
  if (!Number.isFinite(localMs)) return null;
  return Math.floor((localMs - BELARUS_OFFSET_MS) / 1000 / 86400);
}

// Ключ антидубля и заглушки события — `ev:<нормализованное название>:<день>`.
// Один и тот же ключ нужен в чекере (notificationKey), в обработчике кнопки
// «Больше не уведомлять» и в списке заглушённого, поэтому живёт здесь.
export function notificationKey(ev) {
  let ts = ev.startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  // startsAt есть — день по нему; иначе dateText (у «афиши» часто только он).
  const day = Number.isFinite(n) && n > 0
    ? Math.floor(n / 86400)
    : (dayFromDateText(ev.dateText) ?? 'nodate');
  return `ev:${normText(ev.title)}:${day}`;
}

export const WELCOME =
  '🎫 <b>Привет! Я — билетный радар.</b>\n\n' +
  'Я слежу за афишей 24afisha.by, bycard.by, ticketpro.by и bezkassira.by и присылаю уведомление, ' +
  'как только на интересующее вас событие появляются билеты.\n\n' +
  'Что можно отслеживать:\n' +
  '• 🔍 ключевое слово или исполнителя — просто напишите его мне сообщением\n' +
  '• 🎪 конкретное событие или площадку — через кнопку «Найти и следить»\n\n' +
  'Команды:\n' +
  '/list — мой список отслеживания\n' +
  '/help — справка';

export const HELP =
  'ℹ️ <b>Как это работает</b>\n\n' +
  '1. Добавьте, за чем следить: текстовым сообщением (ключевое слово) или через мини-приложение ' +
  '(кнопка «Найти и следить» — там можно выбрать конкретное событие или площадку).\n' +
  '2. Я периодически ищу ваши запросы на 24afisha.by / bycard.by, ticketpro.by и bezkassira.by.\n' +
  '3. Как только на подходящем событии появляются билеты в продаже — присылаю карточку с ценой и ссылкой на покупку.\n\n' +
  'Каждое событие уведомляется один раз.\n' +
  '/list — список отслеживания: у каждой позиции есть ссылка 🔕 «отписаться».\n' +
  'Под карточкой билетов есть кнопка 🔕 «Больше не уведомлять» — она глушит это СОБЫТИЕ\n' +
  'на ВСЕ его даты, а подписка на слово (например, «театр») продолжает работать.\n' +
  'Заглушённое можно вернуть: меню → «🔕 Заглушённые события».\n' +
  '/stop — отключить бота: удаляет все ваши позиции и историю уведомлений.\n\n' +
  'Нашли ошибку или есть пожелание? Кнопка ниже — напишите мне.';

// Reply/инлайн-клавиатура для сообщения «Помощь»: связь с разработчиком и
// «Отключить бота». Отключение переехало сюда из reply-клавиатуры: отдельная
// постоянная кнопка под полем ввода была слишком доступной редкому
// необратимому действию, а в справке она стоит там, где её и ищут.
export function helpKeyboard() {
  return {
    inline_keyboard: [
      // «Заглушённые события» — здесь, а не только в главном меню: главное меню
      // (mainMenuKeyboard) уходит в чат лишь при ПУСТОМ списке позиций, поэтому
      // человек с подписками не видел этой кнопки вообще. Справка — единственное
      // место, куда он заходит сам, и она же обещает «меню → Заглушённые события».
      [{ text: '🔕 Заглушённые события', callback_data: 'muted:list' }],
      [{ text: '✍️ Сообщить об ошибке / пожелание', callback_data: 'feedback:start' }],
      [{ text: DISABLE_BUTTON, callback_data: 'account:disable' }],
    ],
  };
}

export function mainMenuKeyboard(miniUrl, miniConfigured) {
  const rows = [];
  if (miniConfigured) {
    rows.push([{ text: '🔍 Найти и следить', web_app: { url: miniUrl } }]);
  }
  rows.push([{ text: '📋 Мой список', callback_data: 'wl:list' }]);
  rows.push([{ text: '🔕 Заглушённые события', callback_data: 'muted:list' }]);
  // «Отключить бота» живёт в разделе «Помощь» (helpKeyboard), а не отдельной
  // кнопкой меню: редкое и необратимое действие не должно быть на виду.
  rows.push([{ text: 'ℹ️ Помощь', callback_data: 'help' }]);
  return { inline_keyboard: rows };
}

// Текст кнопки «Отключить бота». Вынесен в константу: он одновременно служит
// ПОДПИСЬЮ reply-кнопки и признаком, по которому handlers/message.js узнаёт
// нажатие (Telegram присылает текст кнопки обычным сообщением). Разъедутся —
// кнопка перестанет работать молча.
export const DISABLE_BUTTON = '🚪 Отключить бота';

// Reply-клавиатура: открытие Mini App через KeyboardButton.web_app — ЕДИНСТВЕННЫЙ
// способ, при котором Telegram.WebApp.sendData реально отправляет данные боту.
export function mainReplyKeyboard(miniUrl, miniConfigured) {
  const rows = [];
  if (miniConfigured) {
    rows.push([{ text: '🔍 Найти и следить', web_app: { url: miniUrl } }]);
  }
  rows.push([{ text: '📋 Мой список' }, { text: 'ℹ️ Помощь' }]);
  // Отдельной reply-кнопки «Отключить бота» больше нет — действие живёт в
  // разделе «Помощь» (inline-кнопка → подтверждение → удаление).
  return { keyboard: rows, resize_keyboard: true };
}

// ── «🔕 Заглушённые события» ────────────────────────────────────────────────
//
// Люди глушат события кнопкой под уведомлением, но потом не находят, где это
// включить обратно: подписка на слово «театр» жива, а один спектакль молчит.
// Этот экран — обратный путь: список заглушённого и по кнопке на каждое.
export function renderMutedEvents(rows) {
  if (!rows.length) {
    return (
      '🔕 <b>Заглушённые события</b>\n\n' +
      'Вы пока не отключали уведомления по отдельным событиям.\n' +
      '<i>Кнопка «Больше не уведомлять» под карточкой билетов глушит только то событие, ' +
      'на котором нажата, — сама подписка продолжает работать.</i>'
    );
  }
  const blocks = rows.map((r) => {
    const title = escapeHtml(r.title || 'Событие');
    // Даты в заглушке больше нет: глушится СОБЫТИЕ ЦЕЛИКОМ (все его даты), и
    // дата в списке только путала — могла оказаться одной из многих. Старые
    // записи по дням в базе остаются, но в списке схлопываются по названию.
    return `🔕 <b>${title}</b>`;
  });
  return (
    `🔕 <b>Заглушённые события</b> · ${rows.length}\n\n` +
    blocks.join('\n\n') +
    '\n\n<i>Заглушено событие целиком — на все его даты. Нажмите на событие ниже, ' +
    'чтобы снова получать о нём уведомления.</i>'
  );
}

export function mutedEventsKeyboard(rows) {
  const buttons = (rows || []).slice(0, 40).map((r) => {
    // В строку кнопки больше ~40 символов не влезает.
    const title = String(r.title || 'Событие').slice(0, 34);
    // id строки-заглушки стабилен и влезает в 64 байта: ключ события без дня
    // (`ev:<название>:*`) по длине равен дневному ключу, поэтому отметка «!» не
    // нужна. Ветка с ней осталась для старых сообщений.
    return [{
      text: `🔔 ${title}`.slice(0, 60),
      callback_data: `muted:un:${r.id}`,
    }];
  });
  if (rows && rows.length) buttons.push([{ text: '🔔 Вернуть все', callback_data: 'muted:clear' }]);
  // «Помощь» — обратная дорога: экран открывается из справки (helpKeyboard),
  // и без этой кнопки вернуться можно было только командами. Главное меню сюда
  // не подходит: оно вообще не показывается, когда у чата есть позиции.
  //
  // ВАЖНО: в inline-клавиатуре КАЖДАЯ кнопка должна нести url, callback_data или
  // web_app. Кнопка без них — 400 «can't parse InlineKeyboardButton: Text buttons
  // are not allowed in the inline keyboard», и падает всё сообщение: экран не
  // открывается вообще (так и было — «нажал, ничего не происходит»).
  buttons.push([{ text: '📋 Мой список', callback_data: 'wl:list' }, { text: 'ℹ️ Помощь', callback_data: 'help' }]);
  return { inline_keyboard: buttons };
}

export const MUTED_HINT =
  '💡 Подписка на слово (например, «театр») ловит много спектаклей. ' +
  'Кнопка «🔕 Больше не уведомлять» под карточкой глушит только этот спектакль — ' +
  'само слово остаётся в работе.';

// ── «Отключить бота»: подтверждение и итог ──────────────────────────────────
//
// Удаление необратимо (позиции, история уведомлений, запись пользователя), поэтому
// спрашиваем подтверждение ОТДЕЛЬНОЙ кнопкой. В первом экране нет удаления — только
// «Оставить» и «Удалить», чтобы случайный тап не стёр данные.
export function disableConfirmText(itemsCount) {
  const what = itemsCount
    ? `${itemsCount} ${pluralRu(itemsCount, 'позиция', 'позиции', 'позиций')} слежения`
    : 'все позиции слежения';
  return (
    '🚪 <b>Отключить бота?</b>\n\n' +
    'Я удалю безвозвратно:\n' +
    `• ${what}\n` +
    '• историю уведомлений\n' +
    '• данные вашего профиля в боте\n\n' +
    'Уведомления перестанут приходить сразу, восстановить удалённое нельзя.\n' +
    '<i>Сайты, на которые вы подписаны, и ваши аккаунты там не затрагиваются.</i>'
  );
}

export function disableConfirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🗑 Да, удалить всё', callback_data: 'account:disable:yes' }],
      [{ text: '↩️ Оставить', callback_data: 'account:disable:no' }],
    ],
  };
}

// Итог отключения. Текст без разметки в списках — шлём обычным сообщением.
export function disabledText(counts) {
  const parts = [];
  if (counts.watchItems) parts.push(`${counts.watchItems} ${pluralRu(counts.watchItems, 'позиция', 'позиции', 'позиций')}`);
  if (counts.notifications) parts.push(`${counts.notifications} ${pluralRu(counts.notifications, 'уведомление', 'уведомления', 'уведомлений')}`);
  const removed = parts.length ? ` Удалено: ${parts.join(', ')}.` : '';
  return (
    '✅ <b>Бот отключён</b>\n\n' +
    `Все ваши данные удалены.${removed}\n\n` +
    'Если захотите вернуться — просто нажмите /start, и начнём с чистого листа.'
  );
}

export function proposeAddKeyboard(query) {
  // Кодируем сам запрос в callback_data (иначе при addq: теряется исходное слово).
  //
  // Telegram пускает в callback_data не больше 64 БАЙТ; превышение — 400
  // BUTTON_DATA_INVALID на ВСЁ сообщение, то есть кнопки выбора источника не
  // дойдут вообще. Кириллица в UTF-8 — 2 байта на символ, а base64 раздувает ещё
  // на треть, поэтому порог срабатывает уже на ~25 символах. Длинный запрос в
  // кнопку не кладём: обработчик возьмёт его из текста вопроса
  // (proposeAddText выводит его целиком).
  const q = String(query || '');
  const b64 = Buffer.from(q).toString('base64url');
  const encoded = `addq:bezkassira:${b64}`;
  const payload = Buffer.byteLength(encoded, 'utf8') <= CALLBACK_DATA_MAX ? b64 : CALLBACK_DATA_TRUNCATED;
  return {
    inline_keyboard: [
      [
        { text: '✅ Везде', callback_data: `addq:all:${payload}` },
        { text: '🎭 Афиша', callback_data: `addq:afisha:${payload}` },
        { text: '🎟 Ticketpro', callback_data: `addq:ticketpro:${payload}` },
        { text: '🎫 BezKassira', callback_data: `addq:bezkassira:${payload}` },
      ],
      [{ text: '❌ Отмена', callback_data: 'cancel:add' }],
    ],
  };
}

export function proposeAddText(query) {
  return `Добавить «${escapeHtml(query)}» в отслеживание? Выберите источник:`;
}

// Эмодзи по категории события (кино/театр/концерт/…). Категория — свободный текст
// из мини-приложения, и у источников формулировки различаются (Афиша: «Концерты»,
// Ticketpro: «Концерт», BezKassira: «Выставка»), поэтому матчим по подстроке
// нормализованного текста (нижний регистр, ё→е), а не по точному значению.
const CATEGORY_EMOJI = [
  ['кино', '🎬'],
  ['театр', '🎭'],
  ['концерт', '🎤'],
  ['филармон', '🎤'],
  ['музык', '🎤'],
  ['цирк', '🎪'],
  ['спорт', '⚽'],
  ['выставк', '🖼'],
  ['музей', '🖼'],
  ['фестивал', '🎉'],
  ['дет', '🧸'],
  ['малыш', '🧸'],
  ['балет', '🩰'],
  ['опер', '🩰'],
  ['мюзикл', '🎙'],
  ['шоу', '🎙'],
  ['стендап', '🎙'],
  ['экскурс', '🚌'],
  ['мастер-класс', '🛠'],
  ['лекц', '🛠'],
  ['тренинг', '🛠'],
  ['разное', '📌'],
];

export function categoryEmoji(category) {
  const s = normText(category);
  if (!s) return '🎫';
  for (const [needle, emoji] of CATEGORY_EMOJI) {
    if (s.includes(needle)) return emoji;
  }
  return '🎫';
}

// Эмодзи позиции списка: слово — 🔍, площадка — 🏟, событие — по категории
// (совпадает с плейсхолдерами карточек мини-приложения).
export function itemEmoji(item) {
  if (!item) return '🎫';
  if (item.kind === 'query') return '🔍';
  if (item.kind === 'venue') return '🏟';
  return categoryEmoji(item.category);
}

// Подпись типа позиции: у события с известной категорией показываем её
// (кино/театр/концерт/…), иначе обобщённое «событие»/«площадка»/«слово».
function itemTypeLabel(item) {
  return item.kind === 'event' && item.category ? item.category : (KIND_LABEL[item.kind] || item.kind);
}

// Ссылка-диплинк на бота: тап открывает чат и шлёт /start unsub_<id>, бот
// показывает подтверждение (см. handlers/message.js). Payload диплинка ограничен
// символами [A-Za-z0-9_-], а id позиции — число, так что ограничение соблюдено.
export function unsubDeepLink(id) {
  return `${BOT_LINK_BASE}?start=unsub_${id}`;
}

export function renderWatchlist(items) {
  if (!items.length) {
    return '📋 Список пуст.\nОтправьте мне ключевое слово сообщением или нажмите «Найти и следить», чтобы добавить событие.';
  }
  const blocks = items.map((i) => {
    const title = escapeHtml(i.title || i.query);
    // Название события/площадки — ссылка на её страницу (у ключевого слова
    // страницы нет, поэтому там просто жирный текст).
    const hasUrl = (i.kind === 'event' || i.kind === 'venue') && i.eventUrl;
    const head = `${itemEmoji(i)} <b>${hasUrl ? `<a href="${escapeHtml(i.eventUrl)}">${title}</a>` : title}</b>`;
    const meta = [itemTypeLabel(i), SOURCE_LABEL[i.source] || i.source];
    if (i.city) meta.push(`📍 ${cityLabel(i.city)}`);
    const unsub = `<a href="${escapeHtml(unsubDeepLink(i.id))}">🔕 отписаться</a>`;
    return `${head}\n<i>${escapeHtml(meta.join(' · '))}</i> · ${unsub}`;
  });
  return (
    `📋 <b>Мой список</b> · ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')}\n\n` +
    blocks.join('\n\n') +
    '\n\n<i>🔕 — отписаться от позиции, название ведёт на страницу события или площадки.</i>'
  );
}

// Экран подтверждения отписки (ответ на диплинк /start unsub_<id>).
export function unsubConfirmText(item) {
  const meta = [itemTypeLabel(item), SOURCE_LABEL[item.source] || item.source];
  if (item.city) meta.push(`📍 ${cityLabel(item.city)}`);
  return (
    '🔕 <b>Отписаться?</b>\n\n' +
    `${itemEmoji(item)} <b>${escapeHtml(item.title || item.query)}</b>\n` +
    `<i>${escapeHtml(meta.join(' · '))}</i>\n\n` +
    'Больше не буду присылать уведомления по этой позиции.'
  );
}

export function unsubConfirmKeyboard(id) {
  return {
    inline_keyboard: [
      [{ text: '✅ Да, отписаться', callback_data: `unsub:yes:${id}` }],
      [{ text: '↩️ Оставить в списке', callback_data: `unsub:no:${id}` }],
    ],
  };
}

// В сообщениях списка есть ссылки на страницы событий — превью первой ссылки
// разворачивается в большую карточку под текстом и ломает вид. Отключаем его.
export const NO_LINK_PREVIEW = { is_disabled: true };

export const SOURCE_FULL_LABEL = {
  afisha: 'Афиша (24afisha.by / bycard.by)',
  ticketpro: 'Ticketpro.by',
  bezkassira: 'BezKassira.by',
};

export function ticketCaption(ev) {
  const lines = ['🎫 <b>Появились билеты!</b>', '', `<b>${escapeHtml(ev.title)}</b>`];
  // Даты: первая строка «📅 …» обязана содержать ИМЕННО ev.dateText — по ней
  // обработчик кнопки восстанавливает ключ заглушки (dedupeKeyFromCard), формат
  // «ДД.ММ.ГГГГ ЧЧ:ММ». Дополнительные даты (`extraDates`) идут отдельной
  // строкой: сайты не отдают количество мест, поэтому единственное, что можно
  // сказать про «объём» продажи, — на какие даты билеты уже есть.
  if (ev.dateText) lines.push(`📅 ${escapeHtml(ev.dateText)}`);
  const extra = Array.isArray(ev.extraDates) ? ev.extraDates.filter(Boolean) : [];
  if (extra.length) {
    lines.push(`🗓 Билеты есть и на: ${escapeHtml(extra.join(' · '))}`);
  }
  const place = [ev.venue, ev.city && cityLabel(ev.city)].filter(Boolean).map(escapeHtml).join(', ');
  if (place) lines.push(`📍 ${place}`);
  if (ev.priceFrom) {
    const price = ev.priceTo && ev.priceTo !== ev.priceFrom
      ? `от ${ev.priceFrom} до ${ev.priceTo} ${ev.currency || 'BYN'}`
      : `от ${ev.priceFrom} ${ev.currency || 'BYN'}`;
    lines.push(`💰 ${price}`);
  }
  lines.push('', `<i>${escapeHtml(SOURCE_FULL_LABEL[ev.source] || ev.source)}</i>`);
  return lines.join('\n');
}

export function ticketKeyboard(ev, watchId, dedupeKey) {
  // Для bezkassira источник отдаёт buyUrl (страница /buy/, если билеты в продаже,
  // иначе — сама страница события). Фолбэк сохраняет прежнее поведение.
  const buyUrl = ev.buyUrl
    || (ev.source === 'afisha' ? ev.url.replace(/#.*$/, '') + '#tickets'
      : ev.source === 'bezkassira' ? ev.url.replace(/\/+$/, '') + '/buy/'
        : ev.url);
  const rows = [[{ text: '🎟 Купить билеты', url: buyUrl }]];
  // «Больше не уведомлять» глушит КОНКРЕТНОЕ событие, а не всю подписку.
  // Под словом «театр» лежат десятки спектаклей: человек, которому не нужен один
  // из них, не хочет отключать театр целиком.
  //
  // В callback кладём id позиции (по нему находим владельца) + dedupeKey
  // события (по нему глушим).
  //
  // ВАЖНО: callback_data у Telegram ограничен 64 БАЙТАМИ, и превышение — это не
  // «кнопка не сработает», а HTTP 400 «BUTTON_DATA_INVALID» на ВСЁ сообщение:
  // карточка не отправлялась вообще, позиция падала с исключением, и в отчёте
  // это выглядело как «площадка сломалась» (в проде: две площадки, 52 и 61
  // падение подряд). dedupeKey — это `ev:<нормализованное название>:<день>`,
  // то есть ДЛИНА НАЗВАНИЯ события. «ev:старая волшебная сказка:20816» в
  // base64url — уже 79 байт, а «Представление у Ёлки … Белоснежка …» — 256.
  //
  // Поэтому длинный ключ в кнопку не кладём: обработчик восстановит его из
  // самой карточки (title/dedupKeyOf в handlers/callback_query.js) — название
  // и дата в ней те же, из которых ключ и собран. В кнопку попадает только
  // `mute:<id>:` с меткой «ключ восстанавливаемый».
  if (watchId && dedupeKey) {
    const key = Buffer.from(dedupeKey).toString('base64url');
    const short = `mute:${watchId}:`;
    const fallback = `${short}!`;
    const payload = Buffer.byteLength(short + key, 'utf8') <= CALLBACK_DATA_MAX
      ? short + key
      : fallback;
    rows.push([{ text: '🔕 Больше не уведомлять', callback_data: payload }]);
  }
  return { inline_keyboard: rows };
}
