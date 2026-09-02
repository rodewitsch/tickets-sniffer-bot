// Обработка данных из Mini App (WebApp.sendData).
//
// Важно: `web_app_data` — это поле объекта Message, а не отдельный тип апдейта.
// Платформа вызывает только модули-хендлеры с именами типов апдейтов, поэтому эта
// логика живёт в lib/ и вызывается из handlers/message.js при message.web_app_data.
//
// Формат payload (data): { a: 'add' | 'del', ... }
//   add: { a:'add', k:'query'|'event'|'venue', s:'all'|'afisha'|'ticketpro', q:'запрос',
//          u?:'url события/площадки', t?:'название', c?:'город'|'all', g?:'категория события' }
//   del: { a:'del', id: <id позиции> }
import { api } from '../api.js';
import { addWatchItem, removeWatchItem, KIND_LABEL } from './watch.js';
import { sendFreshReplyKeyboard } from './reply.js';

export const ALLOWED_KINDS = ['query', 'event', 'venue'];
export const ALLOWED_SOURCES = ['all', 'afisha', 'ticketpro', 'bezkassira'];

// Разрешённые символы в слаге города (латиница, цифры, дефис/подчёркивание).
const CITY_SLUG_RE = /^[a-z0-9\-_]+$/;

function sanitizeCity(c) {
  if (c === 'all') return 'all';
  const s = String(c || '').trim().toLowerCase();
  return CITY_SLUG_RE.test(s) ? s : null;
}

// Категория события — свободный текст с мини-приложения (кино/театр/концерт/…):
// режем пробелы и лишнюю длину, чтобы в БД не попал мусор.
function sanitizeCategory(cat) {
  const s = String(cat || '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 60) : null;
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
        category: sanitizeCategory(payload.g),
      });
      if (!res) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Пустой запрос — нечего добавить.' });
        return;
      }
      const label = res.row.title || res.row.query;
      const text = res.duplicate
        ? `«${label}» уже есть в списке отслеживания.`
        : `✅ Добавлено: «${label}» (${KIND_LABEL[res.row.kind]}).`;
      await sendFreshReplyKeyboard(chatId, text);
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
    await sendFreshReplyKeyboard(chatId, '🗑 Позиция удалена из списка отслеживания.');
    return;
  }
}
