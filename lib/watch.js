// CRUD отслеживаемых позиций + снапшот для Mini App.
import { db } from '../db.js';
import { watchItems } from '../schema.js';
import { eq, and, desc } from '../db.js';
import { normText } from './util.js';
import { MINIAPP_URL } from './config.js';

export const KIND_LABEL = {
  query: 'ключевое слово',
  event: 'событие',
  venue: 'площадка',
};

export const SOURCE_LABEL = {
  all: 'все источники',
  afisha: 'Афиша',
  ticketpro: 'Ticketpro',
  bezkassira: 'BezKassira',
};

export async function addWatchItem({ chatId, kind = 'query', source = 'all', query, eventUrl = null, title = null, city = null, category = null, image = null }) {
  const q = String(query || '').trim();
  if (!q) return null;
  const citySlug = city && city !== 'all' ? String(city).trim() : city;
  const existing = await db
    .select()
    .from(watchItems)
    .where(and(eq(watchItems.chatId, chatId), eq(watchItems.active, true)))
    .all();
  const dup = existing.find(
    (i) => i.kind === kind
      && normText(i.query) === normText(q)
      && (i.city || null) === (citySlug || null),
  );
  if (dup) return { row: dup, duplicate: true };

  const [row] = await db
    .insert(watchItems)
    .values({ chatId, kind, source, query: q, eventUrl, title: title || q, city: citySlug, category, image })
    .returning();
  return { row, duplicate: false };
}

export async function listWatchItems(chatId) {
  return db
    .select()
    .from(watchItems)
    .where(and(eq(watchItems.chatId, chatId), eq(watchItems.active, true)))
    .orderBy(desc(watchItems.createdAt))
    .all();
}

export async function removeWatchItem(chatId, id) {
  await db.delete(watchItems).where(and(eq(watchItems.id, id), eq(watchItems.chatId, chatId))).run();
}

export async function deactivateWatchItem(chatId, id) {
  await db
    .update(watchItems)
    .set({ active: false })
    .where(and(eq(watchItems.id, id), eq(watchItems.chatId, chatId)))
    .run();
}

export async function activeWatchItems() {
  return db.select().from(watchItems).where(eq(watchItems.active, true)).all();
}

// Компактный снапшот списка для передачи в Mini App через #-параметр кнопки.
export function miniAppUrl(items) {
  const snap = (items || []).map((i) => ({
    i: i.id,
    k: i.kind,
    s: i.source,
    t: i.title || i.query,
    c: i.city || null,
    g: (i.kind === 'event' && i.category) ? i.category : null,
    // URL страницы события/площадки — только для event/venue, чтобы Mini App мог
    // открыть страницу. Для keyword/query URL нет -> null.
    u: (i.kind === 'event' || i.kind === 'venue') ? (i.eventUrl || null) : null,
    // Постер события/площадки (аналог карточки поиска) — показываем превью в списке.
    // Для keyword/query постера нет -> null.
    m: (i.kind === 'event' || i.kind === 'venue') ? (i.image || null) : null,
  }));
  const encoded = encodeURIComponent(JSON.stringify(snap));
  const sep = MINIAPP_URL.includes('?') ? '&' : '#';
  return `${MINIAPP_URL}${sep}wl=${encoded}`;
}

export function miniAppConfigured() {
  return !MINIAPP_URL.includes('YOUR-USERNAME');
}
