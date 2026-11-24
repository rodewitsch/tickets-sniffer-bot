// CRUD отслеживаемых позиций + снапшот для Mini App.
import { db } from '../db.js';
import { watchItems, notifications, users, venueQueue as venueQueueTable, mutedEvents, feedback } from '../schema.js';
import { eq, and, desc, sql } from '../db.js';
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

// ── «Больше не уведомлять» про КОНКРЕТНОЕ событие ───────────────────────────
//
// Отдельно от позиций: подписка на слово «театр» ловит десятки спектаклей, и
// заглушить один из них не значит отказаться от театра. Ключ — dedupeKey, та же
// единица, что у антидубля уведомлений (notificationKey в lib/checker.js),
// поэтому одно событие с разных агрегаторов глушится одной записью.
//
// moveWatchItemToMuted: под карточкой уведомления лежит кнопка с id ПОЗИЦИИ
// (watchId). Для позиции-события/площадки это и есть «это событие»; для
// ключевика событие определяется карточкой, поэтому dedupeKey приходит из неё.

/**
 * Ключ заглушки СОБЫТИЯ БЕЗ ДАТЫ — `ev:<нормализованное название>:*`.
 *
 * Раньше заглушка жила по дню (`ev:<название>:<день>`, см. notificationKey), и один
 * спектакль с шестью датами приходилось глушить шесть раз: «Плетёный муж» в проде
 * лежал шестью строками (20764…20781), «Рождение империи» — четырьмя. Человек жмёт
 * «больше не уведомлять» про СПЕКТАКЛЬ, а не про сеанс.
 *
 * Формат с «*» вместо дня выбран специально:
 *   • он не совпадает с дневным ключом никогда (там всегда число или 'nodate'),
 *     поэтому старые записи и весь код антидубля продолжают работать как есть;
 *   • длина та же, что у дневного ключа (день заменяется на один символ), поэтому
 *     кнопка `mute:<id>:<base64url>` не начинает внезапно не влезать в 64 байта;
 *   • по ключу видно, что перед нами заглушка «всего события».
 */
export function eventMuteKey(dedupeKey) {
  const key = String(dedupeKey || '');
  const i = key.lastIndexOf(':');
  if (i <= 0) return '';
  return `${key.slice(0, i)}:*`;
}

/**
 * Заглушить событие целиком — все его даты.
 *
 * Пишем ОДНУ строку с ключом без дня. Дневные строки того же события в БД (от
 * предыдущих нажатий) больше не мешают: чекер сверяет только этот ключ, а в
 * списке они схлопываются по названию (dedupeByTitle).
 */
export async function muteEventTitle({ chatId, dedupeKey, title, dateText }) {
  const key = eventMuteKey(dedupeKey);
  if (!chatId || !key) return false;
  await db
    .insert(mutedEvents)
    .values({ chatId, dedupeKey: key, title: title || null, dateText: dateText || null })
    .onConflictDoNothing({ target: [mutedEvents.chatId, mutedEvents.dedupeKey] })
    .run();
  return key;
}

/**
 * Список заглушённого для показа: по одной строке на событие.
 *
 * В БД на одно событие может лежать несколько строк: «главная» без дня плюс
 * легаси-строки по дням (до перехода на заглушку всего события). Показывать их
 * по отдельности бессмысленно — снимутся они тоже вместе (unmuteEventsByTitle).
 * Поэтому схлопываем по нормализованному названию и отдаём самую свежую строку.
 */
export async function listMutedEvents(chatId, limit = 50) {
  const rows = await db
    .select()
    .from(mutedEvents)
    .where(eq(mutedEvents.chatId, chatId))
    .orderBy(desc(mutedEvents.mutedAt))
    .all();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = normText(r.title || '') || `#${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Снять заглушку со ВСЕХ ДАТ события (по его ключу — с днём или без).
 * Возвращает название снятого события или null, если глушить было нечего.
 */
export async function unmuteEventTitle(chatId, dedupeKey) {
  const key = eventMuteKey(dedupeKey);
  if (!chatId || !key) return null;
  // 'ev:<название>:' — общий префикс и «главной» строки (`:*`), и легаси-строк дня.
  const prefix = `${key.slice(0, -1)}%`;
  const rows = await db
    .select()
    .from(mutedEvents)
    .where(and(eq(mutedEvents.chatId, chatId), sql`${mutedEvents.dedupeKey} LIKE ${prefix}`))
    .all();
  if (!rows.length) return null;
  for (const r of rows) {
    await db.delete(mutedEvents).where(and(eq(mutedEvents.id, r.id), eq(mutedEvents.chatId, chatId))).run();
  }
  return rows[0].title || null;
}

/** Снять заглушку у события целиком по id строки из списка. */
export async function unmuteEvent(chatId, id) {
  const row = await db
    .select()
    .from(mutedEvents)
    .where(and(eq(mutedEvents.id, Number(id)), eq(mutedEvents.chatId, chatId)))
    .get();
  if (!row) return null;
  // Снимаем и «главную» строку, и легаси-строки по дням: иначе заглушка
  // «вернётся» следующей же проверкой события на другую дату.
  return unmuteEventTitle(chatId, row.dedupeKey);
}

/** Снять ВСЕ заглушки чата. */
export async function unmuteAllEvents(chatId) {
  await db.delete(mutedEvents).where(eq(mutedEvents.chatId, chatId)).run();
}

/**
 * Полное удаление всех данных пользователя: «Отключить бота».
 *
 * Удаляет ВСЁ, что бот о нём хранит, и в порядке, безопасном без внешних ключей
 * (в SQLite их нет, целостность держим в коде — см. AGENTS.md):
 *   1. venue_queue — очередь площадок: строки этого чата И строки его позиций
 *      (после удаления позиций они остались бы «сиротами» и обходились вечно);
 *   2. watch_items — все позиции (включая неактивные: пользователь просил стереть
 *      данные, а не спрятать их);
 *   3. notifications — история отправок (она нужна только для антидубля, а
 *      новому подписчику дублить уже не надо);
 *   4. feedback — обращения и ответы на них: это личная переписка, «стереть
 *      всё» включает и её (удаляются только обращения ЭТОГО чата);
 *   5. users — сама запись пользователя.
 *
 * Кэш событий (events) НЕ трогаем: это общий справочник по сайтам, а не данные
 * пользователя — те же события нужны остальным подписчикам.
 *
 * @returns {Promise<{watchItems:number, venueQueue:number, notifications:number, users:number}>}
 *   сколько строк удалено (для честного подтверждения в чате).
 */
export async function deleteAllUserData(chatId) {
  // Сначала берём id позиций: venue_queue ссылается на них, а не на чат.
  const own = await db
    .select({ id: watchItems.id })
    .from(watchItems)
    .where(eq(watchItems.chatId, chatId))
    .all();
  const ids = own.map((r) => r.id);

  let venueQueue = 0;
  if (ids.length) {
    const res = await db
      .delete(venueQueueTable)
      .where(sql`${venueQueueTable.chatId} = ${chatId} OR ${venueQueueTable.watchItemId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
      .run();
    venueQueue = res.changes ?? 0;
  } else {
    const res = await db.delete(venueQueueTable).where(eq(venueQueueTable.chatId, chatId)).run();
    venueQueue = res.changes ?? 0;
  }

  const itemsRes = await db.delete(watchItems).where(eq(watchItems.chatId, chatId)).run();
  const notifRes = await db.delete(notifications).where(eq(notifications.chatId, chatId)).run();
  const mutedRes = await db.delete(mutedEvents).where(eq(mutedEvents.chatId, chatId)).run();
  const feedbackRes = await db.delete(feedback).where(eq(feedback.chatId, chatId)).run();
  const userRes = await db.delete(users).where(eq(users.chatId, chatId)).run();

  return {
    watchItems: itemsRes.changes ?? 0,
    venueQueue,
    notifications: notifRes.changes ?? 0,
    mutedEvents: mutedRes.changes ?? 0,
    feedback: feedbackRes.changes ?? 0,
    users: userRes.changes ?? 0,
  };
}

// Одна активная позиция по id — только если она принадлежит этому чату (FK в
// SQLite нет, владельца проверяем в коде). Нужна для отписки по ссылке-диплинку:
// чужой id или уже удалённая позиция дают null.
export async function getWatchItem(chatId, id) {
  if (!Number.isFinite(id)) return null;
  const row = await db
    .select()
    .from(watchItems)
    .where(and(eq(watchItems.id, id), eq(watchItems.chatId, chatId), eq(watchItems.active, true)))
    .get();
  return row || null;
}

export async function deactivateWatchItem(chatId, id) {
  await db
    .update(watchItems)
    .set({ active: false })
    .where(and(eq(watchItems.id, id), eq(watchItems.chatId, chatId)))
    .run();
}

// Точечно обновляет ссылку/город позиции. Нужно для позиций, добавленных до
// правки площадок «афиши»: их ссылка вела на нерабочую страницу площадки, а
// город мог быть выбран вручную. Когда чекер разрешает реальные данные площадки,
// он чинит и ссылку (рабочий фильтр афиши), и город.
export async function updateWatchItemLocation(id, { eventUrl, city } = {}) {
  const set = {};
  if (eventUrl) set.eventUrl = eventUrl;
  if (city !== undefined) set.city = city;
  if (!Object.keys(set).length) return;
  await db.update(watchItems).set(set).where(eq(watchItems.id, id)).run();
}

export async function activeWatchItems() {
  return db.select().from(watchItems).where(eq(watchItems.active, true)).all();
}

// Отметить, что позиция реально проверена в этом цикле: сбрасываем «долг»
// И счётчик провалов подряд.
// Вызывается чекером после успешной проверки (в том числе если событие не в
// продаже — главное, что позицию обработали, бюджета она больше не требует).
export async function markWatchItemChecked(id, now = Math.floor(Date.now() / 1000)) {
  await db
    .update(watchItems)
    .set({ lastCheckedAt: now, deferStreak: 0, failStreak: 0 })
    .where(eq(watchItems.id, id))
    .run();
}

// Позицию отложили из-за бюджета: растёт «долг», поэтому в следующем цикле она
// обгонит тех, кто бюджет получал. Ошибки не считаем «долгом» — их причина не в
// распределении бюджета.
export async function bumpWatchItemDefer(id) {
  await db
    .update(watchItems)
    .set({ deferStreak: sql`COALESCE(${watchItems.deferStreak}, 0) + 1` })
    .where(eq(watchItems.id, id))
    .run();
}

// +1 к счётчику провалов ПОДРЯД у позиции (для правила «частые ошибки = долг»).
// Вызывается из runCheck после item.failed; сбрасывается в markWatchItemChecked.
export async function bumpWatchItemFailures(id) {
  await db
    .update(watchItems)
    .set({ failStreak: sql`COALESCE(${watchItems.failStreak}, 0) + 1` })
    .where(eq(watchItems.id, id))
    .run();
}

/**
 * Снять устаревшие серии провалов у позиций, которые давно не проверялись.
 *
 * Зачем: failStreak — это «сколько раз подряд УПАЛО на последней серии», и он
 * сбрасывается только успешной проверкой. Позиции, которые перестали
 * проверяться вообще (например, их чат заблокировал бота), замирают с высоким
 * значением НАВСЕГДА: в отчёте 09.11 две площадки показывали 62 и 71 «падение
 * подряд», хотя с момента починки их не проверяли ни разу — они просто не
 * ходят в сеть, потому что у чата 403. Модель читала этот счётчик как «падает
 * каждый цикл прямо сейчас» и давала неверную рекомендацию «чини селектор».
 *
 * Счётчик — про ТЕКУЩЕЕ состояние, поэтому старые серии обнуляем: позиция без
 * проверки дольше суток уже не «падает подряд».
 *
 * @param {number} [maxAgeSec] возраст последней проверки, после которого серия неактуальна
 * @returns {Promise<number>} сколько строк обнулено
 */
export async function clearStaleFailStreaks(maxAgeSec = 24 * 60 * 60) {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const res = await db
    .update(watchItems)
    .set({ failStreak: 0 })
    .where(and(
      sql`COALESCE(${watchItems.failStreak}, 0) > 0`,
      sql`(${watchItems.lastCheckedAt} IS NULL OR ${watchItems.lastCheckedAt} < ${cutoff})`,
    ))
    .run();
  return res.changes ?? 0;
}

/**
 * Сбросить долг (deferStreak) у позиций чатов, которые заблокировали бота.
 *
 * Зачем: долг — это право на внеочередную единицу бюджета, когда позицию
 * отложили из-за нехватки квоты. Позициям заблокированного чата он не может
 * помочь НИКОГДА: они не проверяются, поэтому и «отработать» долг не могут.
 * Такие остатки накопились ДО того, как планировщик перестал их учитывать
 * (lib/checker.js): в проде три query-позиции висели с deferStreak 1 и
 * «не проверялись 45 часов», и разбор статистики советовал поднять им
 * приоритет — хотя причина в 403, а не в бюджете. Держим счётчик честным.
 *
 * @returns {Promise<number>} сколько строк обнулено
 */
export async function clearBlockedChatDebt() {
  const res = await db
    .update(watchItems)
    .set({ deferStreak: 0 })
    .where(and(
      sql`COALESCE(${watchItems.deferStreak}, 0) > 0`,
      sql`${watchItems.chatId} IN (SELECT ${users.chatId} FROM ${users} WHERE ${users.blockedAt} IS NOT NULL)`,
    ))
    .run();
  return res.changes ?? 0;
}

/**
 * Позиции, которые СЕЙЧАС более-менее «послушны» идее квоты по числу позиций:
 * активные, без долга и без серии падений. Нужно, чтобы 16 позиций одного чата
 * (из которых 14 падают каждый цикл) не означали «у чата огромная квота» —
 * иначе страдали остальные чаты.
 */
export async function healthyActiveWatchItems() {
  return db
    .select()
    .from(watchItems)
    .where(and(
      eq(watchItems.active, true),
      sql`COALESCE(${watchItems.deferStreak}, 0) = 0`,
      sql`COALESCE(${watchItems.failStreak}, 0) < 3`,
    ))
    .all();
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
