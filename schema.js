import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Пользователи (чат = пользователь для личного бота; поддерживаем и группы).
export const users = sqliteTable('users', {
  chatId: integer('chat_id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  lastSeenAt: integer('last_seen_at').default(sql`(unixepoch())`),
});

// Отслеживаемые позиции.
// kind:   query  — ключевое слово (поиск по всем источникам или выбранному)
//         event  — конкретное событие (проверяем его страницу напрямую)
//         venue  — площадка (следим за всеми событиями площадки)
// source: all | afisha | ticketpro
// city:   город-слаг ('minsk' | 'brest' | …), 'all' — следить во всех городах,
//         NULL — город не выбран (по умолчанию город события из его URL).
// category: тип/категория события (кино/театр/концерт/…), если известна на момент
//         добавления (для kind='event'). Хранится для показа в списке отслеживания.
// image:   URL постера события/площадки (для kind='event'/'venue'), если известен на
//         момент добавления из мини-приложения. Хранится для показа в списке
//         отслеживания (аналог карточки поиска).
export const watchItems = sqliteTable(
  'watch_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    kind: text('kind').notNull().default('query'),
    source: text('source').notNull().default('all'),
    query: text('query').notNull(),
    eventUrl: text('event_url'),
    title: text('title'),
    city: text('city'),
    category: text('category'),
    image: text('image'),
    active: integer('active', { mode: 'boolean' }).default(true),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
    // Последний цикл, в котором позиция реально проверялась (unix-секунды).
    // Нужно для справедливого планирования: порядок обхода — по «долгу» позиции
    // (сколько циклов её откладывали), а не по давности данных её события.
    // NULL — позиция ещё ни разу не проверялась (идёт в первую очередь).
    lastCheckedAt: integer('last_checked_at'),
    // Сколько циклов подряд позицию откладывали из-за бюджета. Каждый пропуск
    // повышает приоритет, успешная проверка сбрасывает в 0. Благодаря этому
    // «голодная» позиция дождётся бюджета, даже если у соседа больше позиций.
    deferStreak: integer('defer_streak').default(0),
  },
  (t) => [
    index('idx_watch_chat').on(t.chatId, t.active),
  ],
);

// Кэш найденных событий.
// Для afisha uid = slug события, для ticketpro = URL события.
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    uid: text('uid').notNull(),
    title: text('title').notNull(),
    venue: text('venue'),
    city: text('city'),
    dateText: text('date_text'),
    startsAt: integer('starts_at'),
    url: text('url').notNull(),
    image: text('image'),
    priceFrom: text('price_from'),
    priceTo: text('price_to'),
    currency: text('currency').default('BYN'),
    onSale: integer('on_sale', { mode: 'boolean' }).default(false),
    status: text('status').default('unknown'), // unknown | onsale | nosale | cancelled | ended
    firstSeenAt: integer('first_seen_at').default(sql`(unixepoch())`),
    updatedAt: integer('updated_at').default(sql`(unixepoch())`),
    lastCheckedAt: integer('last_checked_at'),
  },
  (t) => [
    uniqueIndex('uidx_events_source_uid').on(t.source, t.uid),
  ],
);

// Кто и когда уже получил уведомление о событии (антидубль).
// dedupeKey = 'ev:<нормализованное название>:<день события>' — так одно и то же
// событие у разных агрегаторов не даёт двух уведомлений одному чату.
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    eventId: integer('event_id'),
    dedupeKey: text('dedupe_key').notNull(),
    sentAt: integer('sent_at').default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('uidx_notif_chat_key').on(t.chatId, t.dedupeKey),
  ],
);

// Журнал циклов проверки (для ежедневной статистики): одна строка на выполненный
// цикл. checked/notified/failed — счётчики позиций, уведомлений и ошибок цикла.
// Поля budget_* — утилизация бюджетов опроса за цикл (см. lib/budget.js):
// сколько «деталей» израсходовано/отказано, сколько упёрлось в лимиты площадок
// и городских проверок. Так в статистике видно, хватает ли бюджета.
export const checkLog = sqliteTable(
  'check_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at').default(sql`(unixepoch())`),
    checked: integer('checked').notNull().default(0),
    notified: integer('notified').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    durationMs: integer('duration_ms').default(0),
    detailSpent: integer('detail_spent').default(0),
    detailDenied: integer('detail_denied').default(0),
    // Городские проверки: сколько запросов к городам сделано (cityProbes), сколько
    // позиций-событий ими проверено (cityChecks) и максимум на одну позицию.
    cityProbes: integer('city_probes').default(0),
    cityChecks: integer('city_checks').default(0),
    cityProbesMax: integer('city_probes_max').default(0),
    queryVenuesTried: integer('query_venues_tried').default(0),
    queryVenuesSkipped: integer('query_venues_skipped').default(0),
    // Очередь площадок (venue_queue): поставлено за цикл, сколько ждало обхода,
    // сколько реально обошли и сколько записей оказались «битыми» (отложены).
    venueQueued: integer('venue_queued').default(0),
    venueQueueWaiting: integer('venue_queue_waiting').default(0),
    venueQueueCrawled: integer('venue_queue_crawled').default(0),
    venueQueueFailed: integer('venue_queue_failed').default(0),
    // Добор площадок заранее и откладывание из-за бюджета (курсор сохранён).
    venueQueueEarly: integer('venue_queue_early').default(0),
    venueQueueDeferred: integer('venue_queue_deferred').default(0),
    // Площадку переименовали на сайте — slug обновлён вместо вечного backoff.
    venueQueueRenamed: integer('venue_queue_renamed').default(0),
    // Снимок: сколько РАЗНЫХ площадок битые прямо сейчас (не сумма за сутки).
    venueQueueFailingNow: integer('venue_queue_failing_now').default(0),
    // Сколько раз в поиске нашлось >= MAX_VENUE_RESULTS_PER_QUERY площадок.
    venueQuotaHit: integer('venue_quota_hit').default(0),
    // Обход площадок прерван: всего / по времени / из-за бюджета; сколько отложено.
    venueCrawlTruncated: integer('venue_crawl_truncated').default(0),
    venueCrawlTimeTruncated: integer('venue_crawl_time_truncated').default(0),
    venueCrawlBudgetTruncated: integer('venue_crawl_budget_truncated').default(0),
    venueCrawlDeferred: integer('venue_crawl_deferred').default(0),
    venueCrawlMs: integer('venue_crawl_ms').default(0),
    venueCrawlRuns: integer('venue_crawl_runs').default(0),
    venueEventsTruncated: integer('venue_events_truncated').default(0),
    venueEventsSeen: integer('venue_events_seen').default(0),
    venueEventsPastSkipped: integer('venue_events_past_skipped').default(0),
    resultsTruncated: integer('results_truncated').default(0),
    // Кэш поиска: попадания (сэкономленные запросы к сайтам), промахи и
    // «присоединения» к уже идущему запросу (см. lib/search-cache.js).
    searchCacheHits: integer('search_cache_hits').default(0),
    searchCacheMisses: integer('search_cache_misses').default(0),
    searchCacheJoins: integer('search_cache_joins').default(0),
    // События, не перечитывавшиеся, т.к. не в продаже и стартуют позже горизонта
    // предпродажи (см. RECHECK_PRESALE_HORIZON_DAYS).
    presaleSkipped: integer('presale_skipped').default(0),
    // Отказы в бюджете из-за лимита НА ЧАТ (а не общего исчерпания цикла).
    perChatDenied: integer('per_chat_denied').default(0),
    // Исходы проверки позиций — ответ на «почему позиция ничего не проверила».
    skippedFresh: integer('skipped_fresh').default(0),
    noBudget: integer('no_budget').default(0),
    emptyResult: integer('empty_result').default(0),
    notOnSale: integer('not_on_sale').default(0),
    errorItems: integer('error_items').default(0),
  },
  (t) => [
    index('idx_check_log_started').on(t.startedAt),
  ],
);

// Служебные ключ/значение (время последней проверки и т.п.).
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// Очередь площадок, найденных ПОИСКОМ по ключевому слову (не путать с позициями
// kind='venue' — те пользователь добавил сам и они лежат в watch_items).
//
// Зачем очередь: раньше кандидаты жили только внутри одного вызова
// notifyFromAfishaVenues. Площадку, которую отложил троттлинг
// (VENUE_QUERY_RECHECK_MS) или срезал MAX_VENUE_RESULTS_PER_QUERY, приходилось
// искать заново на следующем цикле — и она снова могла не попасть в тройку.
// В проде это давало 1296 «пропущено по троттлингу» против 85 реальных обходов.
// Теперь найденная площадка кладётся сюда с dueAt и обходится в свой срок.
//
// dueAt — когда площадку можно обходить снова (unix-секунды). Растёт тратами:
// обход (обновили события) → +interval; троттлинг/бюджет → +backoff.
// cursor — сколько событий площадки уже обойдено за последний обход: позволяет
// продолжать длинную сетку с того же места, а не проверять первые MAX_VENUE_EVENTS.
export const venueQueue = sqliteTable(
  'venue_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Позиция-ключевик, из поиска которой нашлась площадка.
    watchItemId: integer('watch_item_id').notNull(),
    // Чат-получатель уведомлений (= watch_items.chat_id на момент постановки).
    chatId: integer('chat_id').notNull(),
    slug: text('slug').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    // Ссылка вела на 404/не открывалась — повторим позже, но с backoff.
    failing: integer('failing', { mode: 'boolean' }).default(false),
    cursor: integer('cursor').default(0),
    // С какого момента площадку можно обходить (unix-секунды).
    dueAt: integer('due_at').notNull().default(0),
    // Последний реальный обход (для статистики «сколько площадок ждут»).
    lastCrawledAt: integer('last_crawled_at'),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('uidx_venue_queue_item_slug').on(t.watchItemId, t.slug),
    index('idx_venue_queue_due').on(t.dueAt),
  ],
);
