// Read-only диагностика прод-БД (не входит в сборку, запускать вручную).
const Database = require('better-sqlite3');
const db = new Database('/data/bot.db', { readonly: true });

const items = db.prepare(`SELECT id, chat_id, kind, source, query, city, active,
  last_checked_at, defer_streak, event_url FROM watch_items WHERE active = 1 ORDER BY id`).all();
console.log('=== ACTIVE ITEMS ===');
for (const r of items) {
  const q = String(r.query || '').slice(0, 34);
  console.log([r.id, r.chat_id, r.kind, r.source, q, r.city || '-',
    r.last_checked_at || '-', 'defer=' + (r.defer_streak || 0),
    r.event_url ? r.event_url.slice(0, 60) : '-'].join(' | '));
}

console.log('\n=== NOTIFICATIONS (3d) ===');
console.log(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE sent_at > unixepoch() - 259200`).get());

console.log('\n=== EVENTS BY SOURCE/ON SALE ===');
for (const r of db.prepare(`SELECT source, on_sale, COUNT(*) AS n FROM events GROUP BY source, on_sale`).all()) {
  console.log(r.source, 'onSale=' + r.on_sale, 'n=' + r.n);
}

console.log('\n=== EVENTS WITH STALE onSale (past start) ===');
console.log(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE on_sale = 1 AND starts_at IS NOT NULL AND starts_at < unixepoch() - 86400`).get());

console.log('\n=== EVENTS NEVER CHECKED ===');
console.log(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE last_checked_at IS NULL`).get());

console.log('\n=== TOP VENUES (on sale) ===');
for (const r of db.prepare(`SELECT venue, COUNT(*) AS n FROM events WHERE on_sale = 1
  GROUP BY venue ORDER BY n DESC LIMIT 15`).all()) {
  console.log(r.n, '|', String(r.venue || '-').slice(0, 50));
}

console.log('\n=== ON-SALE START DATES (afisha) ===');
for (const r of db.prepare(`SELECT date(starts_at, 'unixepoch') AS d, COUNT(*) AS n
  FROM events WHERE on_sale = 1 GROUP BY d ORDER BY d LIMIT 20`).all()) {
  console.log(r.d, 'n=' + r.n);
}

console.log('\n=== TOP check_log (last 20 cycles) ===');
for (const r of db.prepare(`SELECT started_at, checked, notified, failed, duration_ms, detail_spent, detail_denied,
  query_venues_tried AS vt, query_venues_skipped AS vs, venue_quota_hit AS vq,
  venue_crawl_budget_truncated AS cbt, search_cache_hits AS ch, search_cache_misses AS cm
  FROM check_log ORDER BY id DESC LIMIT 20`).all()) {
  console.log(JSON.stringify(r));
}
