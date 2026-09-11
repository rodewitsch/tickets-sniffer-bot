// Цикл проверки: поиск отслеживаемых позиций в источниках, апсерт событий,
// уведомления о появлении билетов.
import db from '../db.js';
import { api } from '../api.js';
import { events, notifications, checkLog, meta } from '../schema.js';
import { eq, and } from '../db.js';
import { CHECK_INTERVAL_MIN, DETAIL_BUDGET } from './config.js';
import { activeWatchItems, updateWatchItemLocation } from './watch.js';
import { searchAfisha, fetchAfishaCityAvailability, fetchAfishaVenueEvents, afishaVenueListingUrl } from './sources/afisha.js';
import { searchTicketpro, fetchTicketproEventDetails, fetchTicketproVenueEventLinks } from './sources/ticketpro.js';
import { searchBezkassira, fetchBezkassiraEventDetails, fetchBezkassiraOrganizerEventLinks } from './sources/bezkassira.js';
import { afishaUidForCity, afishaCityFromUrl } from './normalize.js';
import { cityLabel } from './cities.js';
import { ticketCaption, ticketKeyboard } from './menus.js';
import { normText } from './util.js';

// Как часто перечитывать событие, которое ещё не в продаже (секунды).
const RECHECK_SECONDS = 3 * 60 * 60;
// Сколько результатов поиска обрабатывать на один запрос.
const MAX_RESULTS_PER_QUERY = 10;
// Ключ одноразового сброса устаревшего наличия BezKassira (см. resetStaleBezkassiraOnSale).
const META_BEZ_ON_SALE_RESET = 'bezkassiraOnSaleResetAt';

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

// Разовый сброс наличия у событий BezKassira. Раньше onSale брался из JSON-LD, где
// availability = InStock даже для событий, ещё не поступивших в продажу — из-за
// этого в БД сохранились ложные onSale=true. Сбрасываем их в «неизвестно», чтобы
// цикл перечитал страницу (иначе быстрый путь «известно и в продаже» не даст
// перечитать страницу никогда). Помечаем в meta, чтобы не делать это повторно.
async function resetStaleBezkassiraOnSale() {
  if (await getMeta(META_BEZ_ON_SALE_RESET)) return;
  const stale = await db
    .select()
    .from(events)
    .where(and(eq(events.source, 'bezkassira'), eq(events.onSale, true)))
    .all();
  if (stale.length) {
    await db
      .update(events)
      .set({ onSale: false, status: 'unknown', lastCheckedAt: null })
      .where(and(eq(events.source, 'bezkassira'), eq(events.onSale, true)))
      .run();
    console.log(`[checker] bezKassira: сброшено устаревшее «в продаже» у ${stale.length} событий`);
  }
  await setMeta(META_BEZ_ON_SALE_RESET, String(Math.floor(Date.now() / 1000)));
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
  const sources = item.source === 'all' || !item.source ? ['afisha', 'ticketpro', 'bezkassira'] : [item.source];
  const city = item.city || null;

  for (const src of sources) {
    if (src === 'ticketpro') {
      const found = await searchTicketpro(item.query);
      for (const ref of found.slice(0, MAX_RESULTS_PER_QUERY)) {
        const known = await findByUid('ticketpro', ref.uid);
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
        // Полные данные + реальный статус (у ticketpro JSON-LD не помечает
        // отмену/перенос) — берём со страницы события.
        const ev = await fetchTicketproEventDetails(ref.url);
        if (!ev) continue;
        // Если выбран конкретный город — фильтруем по городу площадки.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      continue;
    }
    if (src === 'bezkassira') {
      const found = await searchBezkassira(item.query);
      for (const ref of found.slice(0, MAX_RESULTS_PER_QUERY)) {
        const known = await findByUid('bezkassira', ref.uid);
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
        const ev = await fetchBezkassiraEventDetails(ref.url);
        if (!ev) continue;
        // Если выбран конкретный город — фильтруем по городу события.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      continue;
    }
    if (src === 'afisha') {
      const { events: refs } = await searchAfisha(item.query);
      for (const ref of refs.slice(0, MAX_RESULTS_PER_QUERY)) {
        // uid city-aware: ищем/создаём запись <slug>@<city>.
        const uid = afishaUidForCity(ref.uid, city);
        const known = await findByUid('afisha', uid);
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
        // Наличие по городу — через schedule API (надёжно, включая кино).
        // По умолчанию (city не задан) проверяем только город из URL результата
        // (обычно Минск), НЕ все города, чтобы не создавать поток запросов.
        const targetCity = (city && city !== 'all') ? city : afishaCityFromUrl(ref.url);
        const { onSale, event: ev } = await fetchAfishaCityAvailability(ref.url, targetCity);
        if (!onSale || !ev) continue;
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
  const city = item.city || null;

  if (/bezkassira\.by/i.test(url)) {
    const ev = await fetchBezkassiraEventDetails(url);
    if (!ev) return 0;
    const up = await upsertEvent(ev);
    return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
  }

  if (!isAfisha) {
    const ev = await fetchTicketproEventDetails(url);
    if (!ev) return 0;
    const up = await upsertEvent(ev);
    return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
  }

  // Наличие по городу берём из schedule API «афиши» (надёжно, включая кино).
  // city = null → только город из URL события (обычно Минск), НЕ все города (иначе
  // будет лишний поток запросов к 24afisha).
  // city = 'brest' → только Брест; city = 'all' → все города до первого onSale.
  const targetCity = city === 'all' ? 'all' : (city || afishaCityFromUrl(url));
  const { onSale, event: ev } = await fetchAfishaCityAvailability(url, targetCity);
  if (!onSale) return 0;
  if (!ev) return 0;
  const up = await upsertEvent(ev);
  return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
}

async function checkVenueItem(item, budget) {
  const url = item.eventUrl || '';
  // Площадка Ticketpro: лента событий площадки + детали (статус отмены/переноса
  // есть только на странице события).
  if (/ticketpro\.by/i.test(url)) {
    let notified = 0;
    const links = await fetchTicketproVenueEventLinks(url);
    for (const link of links.slice(0, 30)) {
      const uid = link.url.replace(/[?#].*$/, '');
      const known = await findByUid('ticketpro', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (budget.left() <= 0) continue;
      budget.spend(1);
      const ev = await fetchTicketproEventDetails(link.url);
      if (!ev) continue;
      const up = await upsertEvent(ev);
      if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
    }
    return notified;
  }
  // Организатор BezKassira (аналог площадки): следим за событиями /organises/….
  if (/bezkassira\.by/i.test(url)) {
    let notified = 0;
    const links = await fetchBezkassiraOrganizerEventLinks(url);
    for (const link of links.slice(0, 30)) {
      const uid = link.uid;
      const known = await findByUid('bezkassira', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (budget.left() <= 0) continue;
      budget.spend(1);
      const ev = await fetchBezkassiraEventDetails(link.url);
      if (!ev) continue;
      const up = await upsertEvent(ev);
      if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
    }
    return notified;
  }
  if (!/24afisha\.by|bycard\.by/.test(url)) {
    return checkQueryItem(item, budget);
  }
  // Площадка «афиши»: старая страница /ru/<city>/events/<slug> не работает, поэтому
  // берём мероприятия из двух API (v3-страница площадки + schedule для кино), см.
  // fetchAfishaVenueEvents. Город площадки определяется бэкендом — выбирать вручную
  // не нужно.
  let notified = 0;
  const { venue, events: found } = await fetchAfishaVenueEvents(url);
  // Починка позиций, добавленных до правки площадок: ссылка вела на нерабочую
  // страницу площадки, город мог быть выбран вручную. Приводим к рабочим данным.
  if (venue) {
    try {
      const listing = afishaVenueListingUrl(venue);
      const newCity = venue.citySlug || null;
      const urlChanged = listing && listing !== item.eventUrl;
      if (urlChanged || newCity !== (item.city || null)) {
        await updateWatchItemLocation(item.id, {
          eventUrl: listing || undefined,
          city: newCity,
        });
      }
    } catch (e) {
      console.warn('venue meta update failed:', e && e.message || e);
    }
  }
  for (const ev of found.slice(0, 40)) {
    const known = await findByUid('afisha', ev.uid);
    if (known && known.onSale) {
      if (await notifyIfDue(item.chatId, known, item.id)) notified++;
      continue;
    }
    const up = await upsertEvent(ev);
    if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
  }
  return notified;
}

// Главная точка входа.
// Возвращает { skipped | checked, notified, failed }.
export async function runCheck({ force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force) {
    const last = Number(await getMeta('lastCheckAt')) || 0;
    if (now - last < CHECK_INTERVAL_MIN * 60) return { skipped: true };
  }

  const startedMs = Date.now();
  // Одноразовая починка данных после исправления наличия BezKassira.
  try {
    await resetStaleBezkassiraOnSale();
  } catch (e) {
    console.warn('bezkassira on-sale reset failed:', e && e.message || e);
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

  // Логируем цикл в check_log (для ежедневной статистики). Сбой записи не роняет проверку.
  try {
    await db.insert(checkLog).values({
      checked: items.length,
      notified,
      failed,
      durationMs: Date.now() - startedMs,
    }).run();
  } catch (e) {
    console.warn('check log insert failed:', e && e.message || e);
  }

  return { checked: items.length, notified, failed };
}
