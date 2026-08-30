// Тексты и клавиатуры бота.
import { escapeHtml, pluralRu } from './util.js';
import { KIND_LABEL, SOURCE_LABEL } from './watch.js';

export const WELCOME =
  '🎫 <b>Привет! Я — билетный радар.</b>\n\n' +
  'Я слежу за афишей 24afisha.by, bycard.by и ticketpro.by и присылаю уведомление, ' +
  'как только на интересующее вас событие появляются билеты.\n\n' +
  'Что можно отслеживать:\n' +
  '• 🔍 ключевое слово или исполнителя — просто напишите его мне сообщением\n' +
  '• 🎪 конкретное событие или площадку — через кнопку «Найти и следить»\n\n' +
  'Команды:\n' +
  '/list — мой список отслеживания\n' +
  '/check — проверить появление билетов прямо сейчас\n' +
  '/help — справка';

export const HELP =
  'ℹ️ <b>Как это работает</b>\n\n' +
  '1. Добавьте, за чем следить: текстовым сообщением (ключевое слово) или через мини-приложение ' +
  '(кнопка «Найти и следить» — там можно выбрать конкретное событие или площадку).\n' +
  '2. Я периодически ищу ваши запросы на 24afisha.by / bycard.by и ticketpro.by.\n' +
  '3. Как только на подходящем событии появляются билеты в продаже — присылаю карточку с ценой и ссылкой на покупку.\n\n' +
  'Каждое событие уведомляется один раз.\n' +
  '/list — список, /check — проверить сейчас.';

export function mainMenuKeyboard(miniUrl, miniConfigured) {
  const rows = [];
  if (miniConfigured) {
    rows.push([{ text: '🔍 Найти и следить', web_app: { url: miniUrl } }]);
  }
  rows.push([
    { text: '📋 Мой список', callback_data: 'wl:list' },
    { text: '⚡ Проверить сейчас', callback_data: 'chk:now' },
  ]);
  rows.push([{ text: 'ℹ️ Помощь', callback_data: 'help' }]);
  return { inline_keyboard: rows };
}

export function proposeAddKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Везде', callback_data: 'addq:all' },
        { text: '🎭 Афиша', callback_data: 'addq:afisha' },
        { text: '🎟 Ticketpro', callback_data: 'addq:ticketpro' },
      ],
      [{ text: '❌ Отмена', callback_data: 'noop' }],
    ],
  };
}

export function proposeAddText(query) {
  return `Добавить «${escapeHtml(query)}» в отслеживание? Выберите источник:`;
}

export function renderWatchlist(items) {
  if (!items.length) {
    return '📋 Список пуст.\nОтправьте мне ключевое слово сообщением или нажмите «Найти и следить», чтобы добавить событие.';
  }
  const lines = items.map((i, n) => {
    const kind = KIND_LABEL[i.kind] || i.kind;
    const src = SOURCE_LABEL[i.source] || i.source;
    return `${n + 1}. ${escapeHtml(i.title || i.query)} — <i>${kind}, ${src}</i>`;
  });
  return (
    `📋 <b>Отслеживается ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')}:</b>\n\n` +
    lines.join('\n') +
    '\n\nНажмите ❌ под позицией, чтобы удалить её.'
  );
}

export function watchlistKeyboard(items) {
  const rows = items.map((i) => [{ text: `❌ ${String(i.title || i.query).slice(0, 28)}`, callback_data: `del:${i.id}` }]);
  rows.push([{ text: '⚡ Проверить сейчас', callback_data: 'chk:now' }]);
  return { inline_keyboard: rows };
}

export const SOURCE_FULL_LABEL = {
  afisha: 'Афиша (24afisha.by / bycard.by)',
  ticketpro: 'Ticketpro.by',
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
  const buyUrl = ev.source === 'afisha' ? ev.url.replace(/#.*$/, '') + '#tickets' : ev.url;
  const rows = [[{ text: '🎟 Купить билеты', url: buyUrl }]];
  if (watchId) rows.push([{ text: '🔕 Больше не уведомлять', callback_data: `mute:${watchId}` }]);
  return { inline_keyboard: rows };
}
