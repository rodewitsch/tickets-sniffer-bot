// Обработка данных из Mini App (WebApp.sendData).
//
// Важно: `web_app_data` — это поле объекта Message, а не отдельный тип апдейта.
// Платформа вызывает только модули-хендлеры с именами типов апдейтов, поэтому эта
// логика живёт в lib/ и вызывается из handlers/message.js при message.web_app_data.
//
// Формат payload (data): { a: 'add' | 'del' | 'chk', ... }
//   add: { a:'add', k:'query'|'event'|'venue', s:'all'|'afisha'|'ticketpro', q:'запрос',
//          u?:'url события/площадки', t?:'название' }
//   del: { a:'del', id: <id позиции> }
//   chk: { a:'chk' }
import { api } from '../api.js';
import { addWatchItem, removeWatchItem, KIND_LABEL } from './watch.js';
import { runCheck } from './checker.js';

export const ALLOWED_KINDS = ['query', 'event', 'venue'];
export const ALLOWED_SOURCES = ['all', 'afisha', 'ticketpro'];

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
    try {
      const res = await addWatchItem({
        chatId,
        kind,
        source,
        query: payload.q,
        eventUrl: payload.u || null,
        title: payload.t || null,
      });
      if (!res) {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Пустой запрос — нечего добавить.' });
        return;
      }
      const label = res.row.title || res.row.query;
      const text = res.duplicate
        ? `«${label}» уже есть в списке отслеживания.`
        : `✅ Добавлено: «${label}» (${KIND_LABEL[res.row.kind]}).\nПроверю при следующем цикле, или нажмите /check.`;
      await api.sendMessage({ chat_id: chatId, text });
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
    await api.sendMessage({ chat_id: chatId, text: '🗑 Позиция удалена из списка отслеживания.' });
    return;
  }

  if (payload.a === 'chk') {
    await api.sendMessage({ chat_id: chatId, text: '🔎 Проверяю источники билетов…' });
    try {
      const res = await runCheck({ force: true });
      await api.sendMessage({
        chat_id: chatId,
        text: res.notified > 0
          ? `✅ Готово: ${res.notified} новое(ых) уведомление(й)!`
          : '✅ Готово: новых билетов не появилось.',
      });
    } catch (e) {
      console.error('check from mini app failed', e);
      await api.sendMessage({ chat_id: chatId, text: '⚠️ Проверка завершилась с ошибкой, попробуйте позже.' });
    }
    return;
  }
}
