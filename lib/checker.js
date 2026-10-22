// Цикл проверки: поиск отслеживаемых позиций в источниках, апсерт событий,
// уведомления о появлении билетов.
import db from '../db.js';
import { api } from '../api.js';
import { events, notifications, checkLog, meta } from '../schema.js';
import { eq, and, sql } from '../db.js';
import { CHECK_INTERVAL_MIN, DETAIL_BUDGET, MAX_VENUE_RESULTS_PER_QUERY, MAX_VENUE_EVENTS, VENUE_CRAWL_BUDGET_MS, VENUE_QUERY_RECHECK_MS } from './config.js';
import { activeWatchItems, updateWatchItemLocation } from './watch.js';
import { searchAfisha, fetchAfishaCityAvailability, fetchAfishaVenue, fetchAfishaVenueEvents, afishaVenueListingUrl, afishaWorkingEventUrl } from './sources/afisha.js';
import { searchTicketpro, fetchTicketproEventDetails, fetchTicketproVenueEventLinks } from './sources/ticketpro.js';
import { searchBezkassira, fetchBezkassiraEventDetails, fetchBezkassiraOrganizerEventLinks } from './sources/bezkassira.js';
import { afishaUidForCity, afishaCityFromUrl } from './normalize.js';
import { cityLabel, venueCityFromSlug } from './cities.js';
import { ticketCaption, ticketKeyboard } from './menus.js';
import { normText, matchesQueryTokens } from './util.js';

// Как часто перечитывать событие, которое ещё не в продаже (секунды).
const RECHECK_SECONDS = 3 * 60 * 60;
// Сколько результатов поиска обрабатывать на один запрос.
const MAX_RESULTS_PER_QUERY = 10;
// Ключ одноразового сброса устаревшего наличия BezKassira (см. resetStaleBezkassiraOnSale).
const META_BEZ_ON_SALE_RESET = 'bezkassiraOnSaleResetAt';
// Ключ разовой починки прошедших событий (см. resetPastEventsOnSale).
const META_PAST_EVENTS_RESET = 'pastEventsResetAt';

// Когда (по часам процесса) последний раз обходили площадку по конкретному
// запросу: ключ = `<watch_item_id>:<venue_slug>`. Живёт в памяти процесса —
// этого достаточно, чтобы один широкий запрос не долбил площадки каждый цикл.
const venueQueryCache = new Map();

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

// Событие по ссылке страницы (позиции kind='event' хранят event_url). Нужно, чтобы
// не ходить на страницу, если данные и так свежие (см. needsRecheck).
async function findEventByUrl(url) {
  if (!url) return null;
  return db.select().from(events).where(eq(events.url, url)).get();
}

// Событие уже прошло? Прошедшее событие не может быть «в продаже» и «ожидается»:
// источники (особенно площадки и кино) продолжают отдавать старые сеансы с
// isSaleOpen=true, и без этой проверки в базе копится вечно «в продаже».
// events.startsAt — unix-секунды (или Date); null — дата неизвестна, не трогаем.
// Допуск PAST_EVENT_GRACE_SEC: startsAt бывает началом дня/сеанса, а сравнение —
// по моменту проверки, поэтому спектакль, начавшийся 10 минут назад, не считаем
// «прошедшим» (иначе статистика «в продаже» просядет уже в день события).
const PAST_EVENT_GRACE_SEC = 86400;
function isPastEvent(startsAt, now = Math.floor(Date.now() / 1000)) {
  let ts = startsAt;
  if (ts instanceof Date) ts = ts.getTime() / 1000;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 && n < now - PAST_EVENT_GRACE_SEC;
}

// Приводит onSale/status к «событие прошло» (ended). Иначе возвращает поля как есть.
function settledSaleState(onSale, status, startsAt, now) {
  if (!isPastEvent(startsAt, now)) return { onSale, status };
  return { onSale: false, status: 'ended' };
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

// Разовая починка: у прошедших событий onSale оставался true (источники отдают
// старые сеансы как «в продаже», а чекер их больше не перечитывает). Кроме
// мусора в базе это ломало ежедневную статистику («в продаже сейчас» была
// завышена в разы). Ставим ended/onSale=false; строки НЕ удаляем — на них
// ссылаются notifications (история отправок), а dedupeKey от event_id не зависит.
// Дата неизвестна (starts_at IS NULL) — не трогаем: угадывать нельзя.
async function resetPastEventsOnSale() {
  if (await getMeta(META_PAST_EVENTS_RESET)) return;
  const now = Math.floor(Date.now() / 1000);
  // Тот же допуск, что в isPastEvent: событие считаем прошедшим только через сутки.
  const cutoff = now - PAST_EVENT_GRACE_SEC;
  const staleWhere = and(eq(events.onSale, true), sql`${events.startsAt} IS NOT NULL AND ${events.startsAt} > 0 AND ${events.startsAt} < ${cutoff}`);
  const stale = await db.select().from(events).where(staleWhere).all();
  if (stale.length) {
    await db
      .update(events)
      .set({ onSale: false, status: 'ended' })
      .where(staleWhere)
      .run();
    console.log(`[checker] прошедшие события: снято «в продаже» у ${stale.length} (status=ended)`);
  }
  await setMeta(META_PAST_EVENTS_RESET, String(now));
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
    // Прошедшее событие сразу сохраняем как ended: источники отдают старые
    // сеансы с isSaleOpen=true, иначе такие строки навсегда остаются «в продаже».
    const sale = settledSaleState(ev.onSale, ev.status, ev.startsAt, now);
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
        onSale: sale.onSale,
        status: sale.status,
        lastCheckedAt: now,
      })
      .returning();
    return { row, wasOnSale: false };
  }
  const nextStartsAt = ev.startsAt || existing.startsAt;
  const sale = settledSaleState(ev.onSale, ev.status, nextStartsAt, now);
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
      onSale: sale.onSale,
      status: sale.status,
      updatedAt: now,
      lastCheckedAt: now,
    })
    .where(eq(events.id, existing.id))
    .run();
  return {
    row: { ...existing, ...ev, onSale: sale.onSale, status: sale.status, startsAt: nextStartsAt, id: existing.id },
    wasOnSale: existing.onSale,
  };
}

async function notifyIfDue(chatId, ev, watchId) {
  if (!ev.onSale || ev.status === 'cancelled') return false;
  const dedupeKey = notificationKey(ev);
  if (await alreadyNotified(chatId, dedupeKey)) return false;
  // Ссылка на событие «афиши» может вести на «битую» страницу 24afisha.by (500) —
  // подменяем на рабочую (bycard.by), чтобы кнопка «Купить билеты» открывалась.
  let out = ev;
  if (ev.source === 'afisha' && ev.url) {
    try {
      out = { ...ev, url: await afishaWorkingEventUrl(ev.url) };
    } catch { /* оставляем исходную ссылку */ }
  }
  const caption = ticketCaption(out);
  const kb = ticketKeyboard(out, watchId);
  try {
    if (out.image) {
      await api.sendPhoto({
        chat_id: chatId,
        photo: out.image,
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
      text: caption + `\n\n${out.url}`,
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

// Пора ли перечитывать уже известное событие. Быстрый путь «знаем и в продаже» +
// RECHECK_SECONDS, чтобы одно и то же событие не перезаписывалось каждый цикл
// (15–30 мин) — достаточно раз в 3 часа.
function needsRecheck(known, now) {
  if (!known || !known.lastCheckedAt) return true;
  const ts = known.lastCheckedAt instanceof Date
    ? known.lastCheckedAt.getTime() / 1000
    : known.lastCheckedAt;
  return now - ts >= RECHECK_SECONDS;
}

// Ссылка на площадку «афиши» умерла (slug переименовали на сайте → 404): без
// починки позиция молча ничего не проверяет (fetchAfishaVenueEvents → venue=null).
// Ищем площадку по названию позиции. Совпадение принимаем только если оно
// однозначное: имя содержит ВСЕ токены названия, покрыто не меньше 75% слов и
// нет конкурента с таким же счётом. Иначе — не угадываем (лучше лог, чем
// подмена одной площадки другой: «Молодёжный театр» vs «Молодёжный театр эстрады»).
function venueNameScore(title, name) {
  const tokens = normText(title).split(' ').filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  if (!matchesQueryTokens(title, name)) return 0;
  const hay = normText(name);
  const covered = tokens.filter((t) => hay.includes(t)).length;
  if (covered / tokens.length < 0.75) return 0;
  // Штраф за лишние слова в названии площадки: «Мир» (1 слово) сильнее совпадает
  // с кинотеатром «Мир», чем «Джаз-клуб Евгения Владимирова».
  const words = hay.split(' ').filter((w) => w.length >= 3);
  const extra = words.filter((w) => !tokens.some((t) => w.includes(t) || t.includes(w))).length;
  return covered * 10 - extra * 3;
}

async function resolveAfishaVenueUrl(item) {
  const title = String(item.title || item.query || '').trim();
  if (!title) return null;
  try {
    const { venues } = await searchAfisha(title);
    const city = item.city || null;
    const scored = (venues || [])
      .map((v) => ({ v, score: venueNameScore(title, v.name || '') }))
      .filter((x) => x.score > 0)
      .filter((x) => {
        if (!city || city === 'all') return true;
        const vCity = venueCityFromSlug(x.v.uid || '');
        return !vCity || vCity === city;
      })
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[1].score >= scored[0].score) return null;
    const venue = await fetchAfishaVenue(scored[0].v.url);
    return afishaVenueListingUrl(venue);
  } catch (e) {
    console.warn('venue url resolve failed:', title, e && e.message || e);
    return null;
  }
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
      const { events: refs, venues } = await searchAfisha(item.query);
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
        // Если выбран конкретный город — фильтруем по фактическому городу события.
        // Фолбэк по JSON-LD подменяет сегмент города в URL, а сайт может отдать
        // событие другого города (напр. могилёвский спектакль по ссылке /minsk/):
        // без этой сверки уведомление уходит на «минскую» позицию. Та же проверка,
        // что и в ветках ticketpro/bezkassira выше.
        if (city && city !== 'all') {
          const evCity = normText(ev.city || '');
          const want = normText(cityLabel(city));
          if (!evCity || evCity !== want) continue;
        }
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
      // Площадки из того же поиска: афиша ищет и по названиям площадок, поэтому
      // запрос «РТБД», «Театр кукол», «Бельведер» отдаёт объект (площадку), а не
      // событие. Без этой ветки такие подписки никогда не срабатывали.
      notified += await notifyFromAfishaVenues(item, venues, city, budget);
    }
  }
  return notified;
}

// Площадки из результатов поиска «афиши» → уведомления по их событиям.
// Работаем как с обычной позицией-площадкой (fetchAfishaVenueEvents), но с
// ограничениями: только подходящие по имени/городу площадки, не больше
// MAX_VENUE_RESULTS_PER_QUERY штук и не дольше VENUE_CRAWL_BUDGET_MS на один
// запрос — иначе один широкий запрос («Театр») обошёл бы пол-сайта.
// Повторный обход той же площадки тем же запросом — не чаще, чем раз в
// VENUE_QUERY_RECHECK_MS.
async function notifyFromAfishaVenues(item, venues, city, budget) {
  if (!Array.isArray(venues) || !venues.length) return 0;
  const candidates = [];
  for (const v of venues) {
    if (!v || !v.url) continue;
    // Точный город площадки знает только сама площадка; если пользователь выбрал
    // конкретный город — отбираем по городу из slug (см. venueCityFromSlug).
    if (city && city !== 'all') {
      const vCity = venueCityFromSlug(v.uid || '');
      if (vCity && vCity !== city) continue;
    }
    // Поиск афиши матчит и по другим полям, поэтому сверяем имя площадки с
    // токенами запроса. Сравнение с транслитом: «Бельведер» → «Belvedere».
    if (!matchesQueryTokens(item.query, v.name || '')) continue;
    candidates.push(v);
    if (candidates.length >= MAX_VENUE_RESULTS_PER_QUERY) break;
  }
  if (!candidates.length) return 0;

  const deadline = Date.now() + VENUE_CRAWL_BUDGET_MS;
  let notified = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const v of candidates) {
    if (Date.now() > deadline) break;
    if (budget.left() <= 0) break;
    const key = `${item.id}:${v.uid}`;
    const last = venueQueryCache.get(key);
    if (last && Date.now() - last < VENUE_QUERY_RECHECK_MS) continue;
    venueQueryCache.set(key, Date.now());
    try {
      const { events: found } = await fetchAfishaVenueEvents(v.url);
      for (const ev of found.slice(0, MAX_VENUE_EVENTS)) {
        if (budget.left() <= 0) break;
        // Прошедшие сеансы не проверяем (см. isPastEvent).
        if (isPastEvent(ev.startsAt, now)) continue;
        const known = await findByUid('afisha', ev.uid);
        if (known && known.onSale) {
          if (await notifyIfDue(item.chatId, known, item.id)) notified++;
          continue;
        }
        if (known && !needsRecheck(known, now)) continue;
        budget.spend(1);
        const up = await upsertEvent(ev);
        if (await notifyIfDue(item.chatId, up.row, item.id)) notified++;
      }
    } catch (e) {
      console.warn('venue (query) check failed:', v.uid, e && e.message || e);
    }
  }
  return notified;
}

async function checkEventItem(item) {
  const url = item.eventUrl;
  if (!url) return 0;
  const now = Math.floor(Date.now() / 1000);
  const isAfisha = /24afisha\.by|bycard\.by/.test(url);
  const city = item.city || null;

  if (/bezkassira\.by/i.test(url)) {
    // Свежую запись перечитывать не нужно: notifyIfDue по ней либо уже сработал,
    // либо не сработает (нет продажи) — поэтому просто выходим.
    const known = await findEventByUrl(url);
    if (known && !needsRecheck(known, now)) return 0;
    const ev = await fetchBezkassiraEventDetails(url);
    if (!ev) return 0;
    const up = await upsertEvent(ev);
    return (await notifyIfDue(item.chatId, up.row, item.id)) ? 1 : 0;
  }

  if (!isAfisha) {
    const known = await findEventByUrl(url);
    if (known && !needsRecheck(known, now)) return 0;
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
  // Ссылка на страницу события могла быть «битой» (SSR 500 на 24afisha.by) —
  // чиним её в позиции (bycard.by), чтобы кнопка «Открыть» работала. Результат
  // проверки кэшируется, так что повторно страница не запрашивается.
  try {
    const fixed = await afishaWorkingEventUrl(url);
    if (fixed && fixed !== item.eventUrl) await updateWatchItemLocation(item.id, { eventUrl: fixed });
  } catch { /* не критично для проверки наличия */ }
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
    const now = Math.floor(Date.now() / 1000);
    const links = await fetchTicketproVenueEventLinks(url);
    for (const link of links.slice(0, MAX_VENUE_EVENTS)) {
      const uid = link.url.replace(/[?#].*$/, '');
      const known = await findByUid('ticketpro', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (known && !needsRecheck(known, now)) continue;
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
    const now = Math.floor(Date.now() / 1000);
    const links = await fetchBezkassiraOrganizerEventLinks(url);
    for (const link of links.slice(0, MAX_VENUE_EVENTS)) {
      const uid = link.uid;
      const known = await findByUid('bezkassira', uid);
      if (known && known.onSale) {
        if (await notifyIfDue(item.chatId, known, item.id)) notified++;
        continue;
      }
      if (known && !needsRecheck(known, now)) continue;
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
  const now = Math.floor(Date.now() / 1000);
  let { venue, events: found } = await fetchAfishaVenueEvents(url);
  // Ссылка могла «умереть»: slug площадки переименовали на сайте → 404 и позиция
  // молча ничего не проверяет. Пробуем найти площадку по названию и починить URL.
  if (!venue) {
    const fixed = await resolveAfishaVenueUrl(item);
    if (fixed && fixed !== item.eventUrl) {
      const retry = await fetchAfishaVenueEvents(fixed);
      if (retry.venue) {
        await updateWatchItemLocation(item.id, { eventUrl: fixed, city: retry.venue.citySlug || undefined });
        venue = retry.venue;
        found = retry.events;
        console.log(`[checker] venue url repaired: ${item.id} -> ${fixed}`);
      }
    }
    if (!venue) {
      console.warn(`[checker] venue not resolved (dead link?): ${item.id} ${url}`);
      return notified;
    }
  }
  // Починка позиций, добавленных до правки площадок: ссылка вела на нерабочую
  // страницу площадки, город мог быть выбран вручную. Приводим к рабочим данным.
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
  // Сетка площадки отдаёт и прошедшие сеансы (у кино — весь день целиком).
  // Событие, начавшееся больше суток назад, проверять бессмысленно: пропускаем
  // ДО запросов к базе, чтобы не тратить цикл.
  let processed = 0;
  for (const ev of found) {
    if (processed >= MAX_VENUE_EVENTS) break;
    if (isPastEvent(ev.startsAt, now)) continue;
    if (budget.left() <= 0) break;
    const known = await findByUid('afisha', ev.uid);
    if (known && known.onSale) {
      if (await notifyIfDue(item.chatId, known, item.id)) notified++;
      continue;
    }
    if (known && !needsRecheck(known, now)) continue;
    budget.spend(1);
    processed++;
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
  // Одноразовая починка: прошедшие события не могут быть «в продаже».
  try {
    await resetPastEventsOnSale();
  } catch (e) {
    console.warn('past events reset failed:', e && e.message || e);
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
