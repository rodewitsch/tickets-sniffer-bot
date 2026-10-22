// Мелкие утилиты без зависимостей.

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

// Битые фразы/бессмыслица в поиске билетных сайтов (Ticketpro/BezKassira при
// нуле совпадений подсовывают случайные/«предстоящие» события). Отсекаем их
// клиентски: результат остаётся, только если хотя бы один значимый токен
// запроса (≥2 симв.) встречается в одном из полей события.
export function textMatchesQuery(query, ...texts) {
  const tokens = normText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return true; // нечего проверять — не фильтруем
  const hay = normText(texts.join(' '));
  return tokens.some((t) => hay.includes(t));
}

// Совпадение названия с токенами запроса с учётом транслитерации: площадки
// «афиши» часто записаны латиницей (Belvedere), а запрос — кириллицей
// («Бельведер»). Сравниваем и нормализованный текст, и его «латинский вид».
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Кириллица → латиница (упрощённая), чтобы сравнивать «Бельведер» и «Belvedere». */
export function translitRu(s) {
  let out = '';
  for (const ch of normText(s)) out += ch in TRANSLIT ? TRANSLIT[ch] : ch;
  return out;
}

/**
 * Содержит ли `haystack` все токены `query` (длиной ≥ minLen). Проверка идёт по
 * обычному тексту и по транслиту — так «Бельведер» находит площадку «Belvedere».
 */
export function matchesQueryTokens(query, haystack, minLen = 3) {
  const tokens = normText(query).split(' ').filter((t) => t.length >= minLen);
  if (!tokens.length) return false;
  const hay = normText(haystack);
  const hayLatin = translitRu(haystack);
  return tokens.every((t) => {
    const tLat = translitRu(t);
    return hay.includes(t) || hayLatin.includes(tLat);
  });
}

export function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function parseDate(input) {
  if (!input) return null;
  const s = String(input);
  // "2026-10-10T19:00:00+0300" / "2026-10-10"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0)) / 1000;
  return { ts, hasTime: !!h };
}

export function formatDateRu(ts, withTime) {
  const d = new Date(ts * 1000);
  const day = d.getUTCDate();
  const mon = MONTHS_GEN[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const base = `${day} ${mon} ${year}`;
  return withTime ? `${base}, ${hh}:${mm}` : base;
}

export function pluralRu(n, one, few, many) {
  n = Math.abs(n) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

export function fmtPrice(from, to, currency) {
  const cur = currency || 'BYN';
  if (from && to && from !== to) return `${from}–${to} ${cur}`;
  if (from) return `от ${from} ${cur}`;
  if (to) return `до ${to} ${cur}`;
  return '';
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
