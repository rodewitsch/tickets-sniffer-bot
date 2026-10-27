// Очередь площадок, найденных ПОИСКОМ по ключевому слову (таблица venue_queue).
//
// Зачем модуль вообще нужен (история бага из прод-статистики):
//   раньше notifyFromAfishaVenues сам решал, кого обойти прямо сейчас, и держал
//   троттлинг в Map в памяти процесса. Итог за сутки: 85 обходов и 1296
//   «пропущено по троттлингу» — площадка, до которой не дошли, просто терялась
//   до следующего цикла, а там её опять мог срезать MAX_VENUE_RESULTS_PER_QUERY.
//   Плюс Map жил в памяти: рестарт контейнера сбрасывал троттлинг и всё
//   обходилось заново.
//
// Теперь площадка — это СТРОКА в БД с dueAt:
//   • нашли в поиске → upsert(с dueAt = сейчас), но не позже уже стоящего dueAt
//     (иначе каждый цикл «оживлял» бы отложенную площадку);
//   • обход начался → claim() сдвигает dueAt по срочности её событий;
//   • сбой обхода → сдвигаем с backoff, чтобы битый slug не долбился каждый цикл.
//
// ВАЖНО: очередь — только для площадок ИЗ ПОИСКА. Позиции kind='venue' живут в
// watch_items и обходятся каждым циклом как обычные позиции.
import db from '../db.js';
import { venueQueue } from '../schema.js';
import { eq, and, lte, gt, asc, not, inArray, sql } from '../db.js';
import { VENUE_QUERY_RECHECK_MS, VENUE_QUEUE_FAIL_BACKOFF_SEC, VENUE_QUEUE_FAIL_BACKOFF_MAX_SEC } from './config.js';

// Ключ площадки: у поиска «афиши» uid площадки = '<slug>@<city>', поэтому один
// slug в двух городах — две разные площадки.
export function venueKey(venue) {
  if (!venue) return null;
  const key = String(venue.uid || '').trim();
  return key || null;
}

/**
 * Ставит/обновляет площадку в очереди. Возвращает true, если запись новая.
 *
 * dueAt передаётся вызывающим (чекер знает, пора ли обходить сейчас): для
 * найденной в поиске площадки это «сейчас», но существующую запись мы НЕ
 * ускоряем — иначе отложенная на сутки дальняя площадка обходилась бы каждый
 * цикл заново.
 */
export async function enqueueVenue({ watchItemId, chatId, venue, dueAt }) {
  const slug = venueKey(venue);
  if (!slug || !venue.url) return false;
  const now = Math.floor(Date.now() / 1000);
  // dueAt НЕ зажимаем в «не раньше сейчас»: он же означает и «уже просрочена»
  // (now - N). Зажим ломал приоритет — все записи получали один dueAt, и
  // очередь отдавала их по id, а не по срочности.
  const due = Number.isFinite(Number(dueAt)) ? Math.trunc(Number(dueAt)) : now;
  const existing = await db
    .select()
    .from(venueQueue)
    .where(and(eq(venueQueue.watchItemId, watchItemId), eq(venueQueue.slug, slug)))
    .get();
  if (existing) {
    // Только обновляем данные площадки и чат; dueAt оставляем прежним — иначе
    // повторная встреча площадки в поиске «оживляла» бы отложенную запись.
    await db
      .update(venueQueue)
      .set({ url: venue.url, title: venue.name || existing.title, chatId })
      .where(eq(venueQueue.id, existing.id))
      .run();
    return false;
  }
  await db
    .insert(venueQueue)
    .values({
      watchItemId,
      chatId,
      slug,
      url: venue.url,
      title: venue.name || null,
      dueAt: due,
      createdAt: now,
    })
    .run();
  return true;
}

/** Сколько записей ждут обхода (dueAt <= now). */
export async function dueVenueCount(now = Math.floor(Date.now() / 1000)) {
  const row = await db
    .select({ n: sql`COUNT(*)` })
    .from(venueQueue)
    .where(lte(venueQueue.dueAt, now))
    .get();
  return Number(row?.n) || 0;
}

/**
 * Забирает до `limit` площадок, срок которых наступил. Порядок: самые «просроченные»
 * первыми (минимальный dueAt), чтобы никто не залипал в хвосте.
 */
export async function dueVenues(limit, now = Math.floor(Date.now() / 1000)) {
  const n = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!n) return [];
  return db
    .select()
    .from(venueQueue)
    .where(lte(venueQueue.dueAt, now))
    .orderBy(asc(venueQueue.dueAt), asc(venueQueue.id))
    .limit(n)
    .all();
}

/**
 * Записи, чей срок ЕЩЁ НЕ наступил, но ближе всех. Нужны для «добора»: если в цикле
 * остался бюджет, а просроченных площадок меньше лимита, лучше обойти ближайшую
 * заранее, чем простаивать. Ротация по dueAt гарантирует, что вперед выходят
 * разные площадки, а не одна и та же голова списка.
 */
export async function upcomingVenues(limit, now = Math.floor(Date.now() / 1000)) {
  const n = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!n) return [];
  return db
    .select()
    .from(venueQueue)
    .where(gt(venueQueue.dueAt, now))
    .orderBy(asc(venueQueue.dueAt), asc(venueQueue.id))
    .limit(n)
    .all();
}

/**
 * Сдвигает срок следующего обхода. Вызывается сразу при взятии площадки в работу,
 * поэтому даже падение внутри обхода не оставит запись «просроченной навсегда».
 */
export async function rescheduleVenue(id, { dueAt, cursor, failing = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const due = Number.isFinite(Number(dueAt)) ? Math.trunc(Number(dueAt)) : now;
  const set = {
    dueAt: due,
    lastCrawledAt: now,
    failing: !!failing,
  };
  if (cursor !== undefined && cursor !== null) set.cursor = Math.max(0, Math.trunc(Number(cursor) || 0));
  await db.update(venueQueue).set(set).where(eq(venueQueue.id, id)).run();
}

/**
 * Сбой обхода (площадка не открылась/не разобралась): откладываем с растущим
 * backoff. Растёт по числу подряд идущих сбоев в самой записи: мы храним только
 * факт failing, поэтому ступень считаем от текущего dueAt — так проще и не
 * требует новой колонки, а ведёт себя так же (1 ч → 3 ч → 12 ч и дальше потолок).
 */
export async function failVenue(id, { dueAt, attempts = 1 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(
    VENUE_QUEUE_FAIL_BACKOFF_MAX_SEC,
    VENUE_QUEUE_FAIL_BACKOFF_SEC * Math.pow(3, Math.max(0, attempts - 1)),
  );
  const base = Number.isFinite(Number(dueAt)) ? Number(dueAt) : 0;
  await db
    .update(venueQueue)
    .set({ dueAt: Math.max(base, now + exp), failing: true, lastCrawledAt: now })
    .where(eq(venueQueue.id, id))
    .run();
}

/** Убирает запись: позиция больше не нужна или площадка больше не находится. */
export async function dropVenue(id) {
  await db.delete(venueQueue).where(eq(venueQueue.id, id)).run();
}

/** Сколько РАЗНЫХ URL в очереди помечено битыми. */
export async function failingVenueCount() {
  const row = await db
    .select({ n: sql`COUNT(DISTINCT url)` })
    .from(venueQueue)
    .where(eq(venueQueue.failing, true))
    .get();
  return Number(row?.n) || 0;
}

/**
 * Площадку ПЕРЕИМЕНОВАЛИ на сайте (старый slug отдаёт 404, поиск находит новый).
 * Тогда старую запись не «лечим» backoff'ом, а заменяем на найденную:
 *
 *   • если у этой же позиции уже есть запись с новым slug — старую просто удаляем
 *     (иначе получаются две строки, и мёртвая долбится вечно);
 *   • иначе подменяем slug/url у существующей строки, сохраняя dueAt и cursor.
 *     dueAt сохраняем потому, что это та же площадка, просто с новым адресом:
 *     сбрасывать срок в «сейчас» значило бы обходить её каждый цикл.
 *
 * Возвращает true, если запись удалось переназначить или удалить.
 */
export async function renameVenue(id, { slug, url, title } = {}) {
  if (!slug || !url) return false;
  const row = await db.select().from(venueQueue).where(eq(venueQueue.id, id)).get();
  if (!row) return false;

  const clash = await db
    .select()
    .from(venueQueue)
    .where(and(eq(venueQueue.watchItemId, row.watchItemId), eq(venueQueue.slug, slug)))
    .get();
  if (clash) {
    // Новая запись уже стоит — старая (мёртвая) больше не нужна.
    await dropVenue(id);
    return true;
  }

  await db
    .update(venueQueue)
    .set({ slug, url, title: title || row.title, failing: false })
    .where(eq(venueQueue.id, id))
    .run();
  return true;
}

/**
 * Убирает записи, которые «дублируют» живую площадку: у той же позиции уже есть
 * строка с рабочим URL, а эта — битая (404). Типичный сценарий: сайт переименовал
 * slug, поиск нашёл новый, enqueueVenue завёл новую строку, а старая висит.
 *
 * Проверка «битая и у позиции есть непустая» не даёт удалить ЕДИНСТВЕННУЮ запись
 * площадки: если другой нет, её надо лечить (renameVenue/failVenue), а не терять.
 *
 * Возвращает число удалённых строк.
 */
export async function dropSupersededVenues() {
  const rows = await db.select().from(venueQueue).all();
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.watchItemId)) byItem.set(r.watchItemId, []);
    byItem.get(r.watchItemId).push(r);
  }
  let removed = 0;
  for (const list of byItem.values()) {
    const healthy = list.filter((r) => !r.failing);
    if (!healthy.length) continue;
    for (const r of list) {
      if (!r.failing) continue;
      // Та же площадка в живом виде? Сравниваем по «хвосту» slug: у переименованной
      // площадки меняется только префикс («5148-brestskij-teatr-kukol» →
      // «5148-zasluzhennyj-…-brestskij-teatr-kukol»), а число в начале сохраняется.
      const same = healthy.some((h) => venueLooksSame(r.slug, h.slug));
      if (!same) continue;
      await dropVenue(r.id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Похоже ли, что два slug'а — одна и та же площадка после переименования.
 * Признак консервативный (ошибиться в сторону «не трогать» дешевле):
 *   • совпадает числовой префикс (`5148-…`), ИЛИ
 *   • один slug целиком содержится в другом.
 */
export function venueLooksSame(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const na = /^(\d+)-/.exec(sa)?.[1];
  const nb = /^(\d+)-/.exec(sb)?.[1];
  if (na && nb) return na === nb;
  return sa.includes(sb) || sb.includes(sa);
}

/** Чистка очереди для удалённых/выключенных позиций (FK в SQLite нет). */
export async function pruneVenueQueue(activeItemIds) {
  const ids = [...new Set((activeItemIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) {
    await db.delete(venueQueue).run();
    return;
  }
  await db.delete(venueQueue).where(not(inArray(venueQueue.watchItemId, ids))).run();
}

export { VENUE_QUERY_RECHECK_MS };
