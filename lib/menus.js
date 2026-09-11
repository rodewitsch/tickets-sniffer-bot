// Тексты и клавиатуры бота.
import { escapeHtml, pluralRu, normText } from './util.js';
import { KIND_LABEL, SOURCE_LABEL } from './watch.js';
import { cityLabel } from './cities.js';
import { BOT_LINK_BASE } from './config.js';

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
  '/list — список отслеживания: у каждой позиции есть ссылка 🔕 «отписаться».\n\n' +
  'Нашли ошибку или есть пожелание? Кнопка ниже — напишите мне.';

// Reply/инлайн-клавиатура для сообщения «Помощь»: кнопка связи с разработчиком.
export function helpKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✍️ Сообщить об ошибке / пожелание', callback_data: 'feedback:start' }],
    ],
  };
}

export function mainMenuKeyboard(miniUrl, miniConfigured) {
  const rows = [];
  if (miniConfigured) {
    rows.push([{ text: '🔍 Найти и следить', web_app: { url: miniUrl } }]);
  }
  rows.push([{ text: '📋 Мой список', callback_data: 'wl:list' }]);
  rows.push([{ text: 'ℹ️ Помощь', callback_data: 'help' }]);
  return { inline_keyboard: rows };
}

// Reply-клавиатура: открытие Mini App через KeyboardButton.web_app — ЕДИНСТВЕННЫЙ
// способ, при котором Telegram.WebApp.sendData реально отправляет данные боту.
export function mainReplyKeyboard(miniUrl, miniConfigured) {
  const rows = [];
  if (miniConfigured) {
    rows.push([{ text: '🔍 Найти и следить', web_app: { url: miniUrl } }]);
  }
  rows.push([{ text: '📋 Мой список' }, { text: 'ℹ️ Помощь' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function proposeAddKeyboard(query) {
  // Кодируем сам запрос в callback_data (иначе при addq: теряется исходное слово).
  const b64 = Buffer.from(String(query || '')).toString('base64url');
  return {
    inline_keyboard: [
      [
        { text: '✅ Везде', callback_data: `addq:all:${b64}` },
        { text: '🎭 Афиша', callback_data: `addq:afisha:${b64}` },
        { text: '🎟 Ticketpro', callback_data: `addq:ticketpro:${b64}` },
        { text: '🎫 BezKassira', callback_data: `addq:bezkassira:${b64}` },
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
    '\\n\\n<i>🔕 — отписаться от позиции, название ведёт на страницу события или площадки.</i>'
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
  if (ev.dateText) lines.push(`📅 ${escapeHtml(ev.dateText)}`);
  const place = [ev.venue, ev.city].filter(Boolean).map(escapeHtml).join(', ');
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

export function ticketKeyboard(ev, watchId) {
  // Для bezkassira источник отдаёт buyUrl (страница /buy/, если билеты в продаже,
  // иначе — сама страница события). Фолбэк сохраняет прежнее поведение.
  const buyUrl = ev.buyUrl
    || (ev.source === 'afisha' ? ev.url.replace(/#.*$/, '') + '#tickets'
      : ev.source === 'bezkassira' ? ev.url.replace(/\/+$/, '') + '/buy/'
        : ev.url);
  const rows = [[{ text: '🎟 Купить билеты', url: buyUrl }]];
  if (watchId) rows.push([{ text: '🔕 Больше не уведомлять', callback_data: `mute:${watchId}` }]);
  return { inline_keyboard: rows };
}
