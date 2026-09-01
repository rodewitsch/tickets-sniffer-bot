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
    active: integer('active', { mode: 'boolean' }).default(true),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
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

// Служебные ключ/значение (время последней проверки и т.п.).
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});
