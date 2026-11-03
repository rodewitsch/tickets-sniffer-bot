// Приводит ticketpro-ссылки к каноническому виду после редизайна сайта.
//
// Старый формат: https://www.ticketpro.by/bilety-na-koncert/<slug>/
// Новый:         https://ticketpro.by/ru/event/<slug>
// Площадки:      https://www.ticketpro.by/koncertnye-ploshhadki/<slug>/ → /ru/venues/<slug>
//
// Зачем: новый парсер (lib/sources/ticketpro.js) отдаёт канонические URL, а
// идентичность события в базе — это URL (events.uid / events.url). Если не
// переписать старые ссылки, тот же самый ивент будет найден заново и создаст
// строку-дубль (старая строка останется «в продаже» навсегда).
//
// Идемпотентен: ссылки, уже имеющие канонический вид, не трогаются.
//
// Запуск на сервере (better-sqlite3 есть только в контейнере):
//   docker cp scripts/normalize-ticketpro-urls.cjs tickets-bot:/app/
//   docker exec -w /app tickets-bot node normalize-ticketpro-urls.cjs
const Database = require('better-sqlite3');
const path = process.env.DB_PATH || '/data/bot.db';
const db = new Database(path);

const SITE = 'https://ticketpro.by';

function slugFromPath(p) {
  const s = String(p || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const segs = s.split('/').filter(Boolean);
  return segs.length ? decodeURIComponent(segs[segs.length - 1]) : null;
}

// Обрабатываем только реальные ссылки на ticketpro.by (в базе бывают и
// тестовые фикстуры вида 'https://t/1' — их не трогаем).
function isTicketproUrl(p) {
  return /ticketpro\.by\//i.test(String(p || ''));
}

// events: uid и url — одна и та же ссылка для ticketpro.
{
  const rows = db
    .prepare("SELECT id, uid, url FROM events WHERE source = 'ticketpro'")
    .all();
  let updated = 0;
  let deleted = 0;
  const seen = new Map(); // canonical uid -> id
  // Уже канонические строки помечаем первыми (на случай повторного/прерванного
  // запуска, чтобы не наткнуться на UNIQUE при сведении дублей).
  for (const r of rows) {
    if (r.url === r.uid && r.url.startsWith(`${SITE}/ru/event/`)) seen.set(r.url, r.id);
  }
  for (const r of rows) {
    if (!isTicketproUrl(r.url)) continue;
    const slug = slugFromPath(r.url);
    if (!slug) continue;
    const canonical = `${SITE}/ru/event/${slug}`;
    if (r.url === canonical && r.uid === canonical) continue;
    if (seen.has(canonical)) {
      db.prepare('DELETE FROM events WHERE id = ?').run(r.id);
      deleted++;
      continue;
    }
    db.prepare('UPDATE events SET url = ?, uid = ? WHERE id = ?').run(canonical, canonical, r.id);
    seen.set(canonical, r.id);
    updated++;
  }
  console.log(`events: переписано ${updated}, удалено дублей ${deleted}`);
}

// watch_items: kind='event' → ссылка события, kind='venue' → ссылка площадки.
{
  const rows = db
    .prepare("SELECT id, kind, event_url FROM watch_items WHERE source = 'ticketpro'")
    .all();
  let updated = 0;
  for (const r of rows) {
    if (!isTicketproUrl(r.event_url)) continue;
    const slug = slugFromPath(r.event_url);
    if (!slug) continue;
    if (r.kind === 'venue') {
      const canonical = `${SITE}/ru/venues/${slug}`;
      if (r.event_url !== canonical) {
        db.prepare('UPDATE watch_items SET event_url = ? WHERE id = ?').run(canonical, r.id);
        updated++;
      }
    } else if (r.kind === 'event') {
      const canonical = `${SITE}/ru/event/${slug}`;
      if (r.event_url !== canonical) {
        db.prepare('UPDATE watch_items SET event_url = ? WHERE id = ?').run(canonical, r.id);
        updated++;
      }
    }
  }
  console.log(`watch_items: переписано ${updated}`);
}

db.close();
console.log('готово');
