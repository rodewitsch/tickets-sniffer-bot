// Цикл проверки: поиск отслеживаемых позиций в источниках, апсерт событий,
// уведомления о появлении билетов.
import db from '../db.js';
import { api } from '../api.js';
import { events, notifications, meta } from '../schema.js';
import { eq, and } from '../db.js';
import { CHECK_INTERVAL_MIN, DETAIL_BUDGET } from './config.js';
import { activeWatchItems } from './watch.js';
import { searchAfisha, fetchAfishaEventDetails, fetchVenueEventLinks } from './sources/afisha.js';
import { searchTicketpro, fetchTicketproEventDetails } from './sources/ticketpro.js';
import { afishaSlugFromUrl } from './normalize.js';
import { ticketCaption, ticketKeyboard } from './menus.js';
import { normText } from './util.js';

// Как часто перечитывать событие, которое ещё не в продаже (секунды).
const RECHECK_SECONDS = 3 * 60 * 60;
// Сколько результатов поиска обрабатывать на один запрос.
const MAX_RESULTS_PER_QUERY = 10;

async function getMeta(key) {
  const row = await db.select().from(meta).where(eq(meta.key, key)).get();
  return row ? row.value : null;
}

async function setMeta(key, value) {
  await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

async function findByUid(source, uid) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.source, source), eq(events.uid, uid)))
    .get();
}

function notificationKey(ev) {
  let ts = ev.startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const day = ts ? Math.floor(Number(ts) / 86400) : 'nodate';
  return `ev:${normText(ev.title)}:${day}`;
}

async function alreadyNotified(chatId, dedupeKey) {
  const row = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.chatId, chatId), eq(notifications.dedupeKey, dedupeKey)))
    .get();
  return !!row;
}

async function upsertEvent(ev) {
  const now = Math.floor(Date.now() / 1000);
  const existing = await findByUid(ev.source, ev.uid);
  if (!existing) {
    const [row] = await db
      .insert(events)
      .values({
        source: ev.source,
        uid: ev.uid,
        title: ev.title,
        venue: ev.venue,
        city: ev.city,
        dateText: ev.dateText,
        startsAt: ev.startsAt,
        url: ev.url,
        image: ev.image,
        priceFrom: ev.priceFrom,
        priceTo: ev.priceTo,
        currency: ev.currency,
        onSale: ev.onSale,
        status: ev.status,
        lastCheckedAt: now,
      })
      .returning();
    return { row, wasOnSale: false };
  }
  await db
    .update(events)
    .set({
      title: ev.title,
      venue: ev.venue || existing.venue,
      city: ev.city || existing.city,
      dateText: ev.dateText || existing.dateText,
      startsAt: ev.startsAt || existing.startsAt,
      url: ev.url,
      image: ev.image || existing.image,
      priceFrom: ev.priceFrom || existing.priceFrom,
      priceTo: ev.priceTo || existing.priceTo,
      currency: ev.currency || existing.currency,
      onSale: ev.onSale,
      status: ev.status,
      updatedAt: now,
      lastCheckedAt: now,
    })
    .where(eq(events.id, existing.id))
    .run();
  return { row: { ...existing, ...ev, id: existing.id }, wasOnSale: existing.onSale };
}

async function notifyIfDue(chatId, ev, watchId) {
  if (!ev.onSale || ev.status === 'cancelled') return false;
  const dedupeKey = notificationKey(ev);
  if (await alreadyNotified(chatId, dedupeKey)) return false;
  const caption = ticketCaption(ev);
  const kb = ticketKeyboard(ev, watchId);
  try {
    if (ev.image) {
      await api.sendPhoto({
        chat_id: chatId,
        photo: ev.image,
        caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await api.sendMessage({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  } catch (e) {
    // Картинка по внешней ссылке может не загрузиться — шлем текстом.
    console.warn('photo failed, fallback to text:', e.message);
    await api.sendMessage({
      chat_id: chatId,
      text: caption + `\n\n${ev.url}`,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }
  try {
    await db.insert(notifications).values({ chatId, eventId: ev.id, dedupeKey }).run();
  } catch {
    // уникальность (chat, dedupeKey) уже соблюдена конкурентным циклом
  }
  return true;
}

function budgetTracker(total) {
  let left = total;
  return {
    left: () => left,
    spend: (n) => { left -= n; },
  };
}

async function checkQueryItem(item, budget) {
  let notified = 0;
  const now = Math.floor(Date.now() / 1000);
  const sources = item.source === 'all' || !item.source ? ['afisha', 'ticketpro'] : [item.source];

  for (const src of sources) {
    if (src === 'ticketpro') {
      const found = await searchTicketpro(item.query);
      for (const ev of found.slice(0, MAX_RESULTS_PER_QUERY)) {
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      continue;
    }
    if (src === 'afisha') {
      const { events: refs } = await searchAfisha(item.query);
      for (const ref of refs.slice(0, MAX_RESULTS_PER_QUERY)) {
        const known = await findByUid('afisha', ref.uid);
        if (known && known.onSale) {
          if (await notifyIfDue(item.chatId, known, item.id)) notified++;
          continue;
        }
        if (known && known.lastCheckedAt) {
          const ts = known.lastCheckedAt instanceof Date
            ? known.lastCheckedAt.getTime() / 1000
            : known.lastCheckedAt;
          if (now - ts < RECHECK_SECONDS) continue;
        }
        if (budget.left() <= 0) continue;
        budget.spend(1);
        const ev = await fetchAfishaEventDetails(ref.url);
        if (!ev) continue;
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
    }
  }
  return notified;
}

async function checkEventItem(item) {
  const url = item.eventUrl;
  if (!url) return 0;
  const isAfisha = /24afisha\.by|bycard\.by/.test(url);
  const ev = isAfisha
    ? await fetchAfishaEventDetails(url)
    : await fetchTicketproEventDetails(url);
  if (!ev) return 0;
  const up = await upsertEvent(ev);
  return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
}

async function checkVenueItem(item, budget) {
  if (!item.eventUrl || !/24afisha\.by|bycard\.by/.test(item.eventUrl)) {
    return checkQueryItem(item, budget);
  }
  let notified = 0;
  const links = await fetchVenueEventLinks(item.eventUrl);
  for (const link of links.slice(0, 30)) {
    const uid = afishaSlugFromUrl(link.url);
    const known = await findByUid('afisha', uid);
    if (known && known.onSale) {
      if (await notifyIfDue(item.chatId, known, item.id)) notified++;
      continue;
    }
    if (budget.left() <= 0) continue;
    budget.spend(1);
    const ev = await fetchAfishaEventDetails(link.url);
    if (!ev) continue;
    const up = await upsertEvent(ev);
    if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
  }
  return notified;
}

// Главная точка входа.
// Возвращает { skipped | checked, notified }.
export async function runCheck({ force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const last = Number(await getMeta('lastCheckAt')) || 0;
    if (now - last < CHECK_INTERVAL_MIN * 60) return { skipped: true };
  }

  const items = await activeWatchItems();
  const budget = budgetTracker(DETAIL_BUDGET);
  let notified = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (item.kind === 'event') notified += await checkEventItem(item);
      else if (item.kind === 'venue') notified += await checkVenueItem(item, budget);
      else notified += await checkQueryItem(item, budget);
    } catch (e) {
      failed++;
      console.warn('check failed for item', item.id, e.message);
    }
  }

  await setMeta('lastCheckAt', String(now));
  return { checked: items.length, notified, failed };
}
