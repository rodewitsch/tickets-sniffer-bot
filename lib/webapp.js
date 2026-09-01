// Обработка данных из Mini App (WebApp.sendData).
//
// Важно: `web_app_data` — это поле объекта Message, а не отдельный тип апдейта.
// Платформа вызывает только модули-хендлеры с именами типов апдейтов, поэтому эта
// логика живёт в lib/ и вызывается из handlers/message.js при message.web_app_data.
//
// Формат payload (data): { a: 'add' | 'del', ... }
//   add: { a:'add', k:'query'|'event'|'venue', s:'all'|'afisha'|'ticketpro', q:'запрос',
//          u?:'url события/площадки', t?:'название', c?:'город'|'all' }
//   del: { a:'del', id: <id позиции> }
import { api } from '../api.js';
import { addWatchItem, removeWatchItem, listWatchItems, miniAppUrl, KIND_LABEL } from './watch.js';
import { mainReplyKeyboard } from './menus.js';

export const ALLOWED_KINDS = ['query', 'event', 'venue'];
export const ALLOWED_SOURCES = ['all', 'afisha', 'ticketpro'];

// Разрешённые символы в слаге города (латиница, цифры, дефис/подчёркивание).
const CITY_SLUG_RE = /^[a-z0-9\-_]+$/;

function sanitizeCity(c) {
  if (c === 'all') return 'all';
  const s = String(c || '').trim().toLowerCase();
  return CITY_SLUG_RE.test(s) ? s : null;
}

// Отправляет сообщение с актуальной reply-клавиатурой (свежий снапшот списка).
async function sendWithFreshKeyboard(chatId, text) {
  const items = await listWatchItems(chatId);
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: mainReplyKeyboard(miniAppUrl(items), true),
  });
}

export async function handleWebAppData(chatId, rawData) {
  if (!chatId) return;
  console.log('[webapp] handling for chat', chatId, 'raw:', rawData);

  let payload = {};
  try {
    payload = JSON.parse(rawData || '{}');
  } catch {
    await api.sendMessage({ chat_id: chatId, text: '⚠️ Не удалось разобрать данные из мини-приложения.' });
    return;
  }

  if (payload.a === 'add') {
    const kind = ALLOWED_KINDS.includes(payload.k) ? payload.k : 'query';
    const source = ALLOWED_SOURCES.includes(payload.s) ? payload.s : 'all';
    const city = sanitizeCity(payload.c);
    try {
      const res = await addWatchItem({
        chatId,
        kind,
        source,
        query: payload.q,
        eventUrl: payload.u || null,
        title: payload.t || null,
        city,
      });
      if (!res) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Пустой запрос — нечего добавить.' });
        return;
      }
      const label = res.row.title || res.row.query;
      const text = res.duplicate
        ? `«${label}» уже есть в списке отслеживания.`
        : `✅ Добавлено: «${label}» (${KIND_LABEL[res.row.kind]}).`;
      await sendWithFreshKeyboard(chatId, text);
      console.log('[webapp] add OK for chat', chatId, 'kind', kind, 'dup', !!res.duplicate, '->', label);
    } catch (e) {
      console.error('[webapp] add FAILED for chat', chatId, ':', e && e.message || e);
      try {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Не удалось добавить. Попробуйте ещё раз.' });
      } catch {}
    }
    return;
  }

  if (payload.a === 'del') {
    await removeWatchItem(chatId, Number(payload.id));
    await sendWithFreshKeyboard(chatId, '🗑 Позиция удалена из списка отслеживания.');
    return;
  }
}
