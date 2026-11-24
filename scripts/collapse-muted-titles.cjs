// Разовая чистка сохранённых заглушек: по одной строке на событие.
//
// Заглушка «больше не уведомлять» раньше жила по дню (`ev:<название>:<день>`),
// поэтому один спектакль с шестью датами лежал шестью строками. Теперь глушится
// событие целиком (`ev:<название>:*`, см. eventMuteKey в lib/watch.js), и дневные
// строки становятся мусором: они только путают список «Заглушённые события».
//
// Скрипт СХЛОПЫВАЕТ каждую группу одинаковых названий в ОДНУ строку:
//   • если в группе есть «главная» строка (`:*`) — остальные удаляются;
//   • если нет — из самой свежей дневной строки делается «главная», остальные удаляются.
// Дату для показа переносим из самой свежей дневной строки.
//
// Запуск: node collapse-muted-titles.cjs [--dry] [--all]
//   --all — превратить в «все даты» и ОДИНОЧНЫЕ дневные строки (иначе у них
//           следующая дата того же спектакля снова придёт с уведомлением).
// В Docker: docker exec -w /app tickets-bot node collapse-muted-titles.cjs --dry
const Database = require('better-sqlite3');

const dry = process.argv.includes('--dry');
const all = process.argv.includes('--all');
const db = new Database(process.env.DB_PATH || '/data/bot.db');

const normText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const titleKey = (k) => {
  const i = String(k || '').lastIndexOf(':');
  return i > 0 ? `${k.slice(0, i)}:*` : String(k || '');
};

const rows = db.prepare('SELECT id, chat_id, dedupe_key, title, date_text, muted_at FROM muted_events ORDER BY chat_id, muted_at DESC').all();
const groups = new Map();
for (const r of rows) {
  const key = `${r.chat_id}|${normText(r.title || '')}`;
  const g = groups.get(key) || [];
  g.push(r);
  groups.set(key, g);
}

let collapsed = 0;
let kept = 0;
for (const [key, group] of groups) {
  const soleDated = group.length === 1 && titleKey(group[0].dedupe_key) !== group[0].dedupe_key;
  if (group.length === 1 && !(all && soleDated)) { kept += 1; continue; }
  const main = group.find((r) => titleKey(r.dedupe_key) === r.dedupe_key);
  const newestDated = group.find((r) => r.date_text);
  const survivor = main || group[0];
  const survivorKey = main ? main.dedupe_key : titleKey(group[0].dedupe_key);
  console.log(`${dry ? '[dry] ' : ''}${key}: ${group.length} -> 1 (id ${survivor.id} -> ${survivorKey})`);
  if (!dry) {
    const tx = db.transaction(() => {
      if (!main) {
        // Дневную строку превращаем в «главную». Если такая уже есть — merge ниже.
        db.prepare('UPDATE muted_events SET dedupe_key = ?, date_text = COALESCE(date_text, ?) WHERE id = ?')
          .run(survivorKey, newestDated ? newestDated.date_text : null, survivor.id);
      } else if (!main.date_text && newestDated) {
        db.prepare('UPDATE muted_events SET date_text = ? WHERE id = ?').run(newestDated.date_text, main.id);
      }
      for (const r of group) {
        if (r.id !== survivor.id) db.prepare('DELETE FROM muted_events WHERE id = ?').run(r.id);
      }
    });
    tx();
  }
  collapsed += group.length - 1;
  kept += 1;
}

console.log(`${dry ? 'DRY RUN — ' : ''}событий: ${kept}, удалено строк: ${collapsed}`);
db.close();
