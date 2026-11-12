// Мелкие утилиты без зависимостей.

// ── Разбор HTML простым сканером ─────────────────────────────────────────────
//
// На регулярке «найти тег» CodeQL ругается (js/incomplete-multi-character-sanitization:
// `<!--` внутри строки не даёт доказать полноту «очистки»). Поэтому разбор —
// посимвольный сканер слева направо. Комментарии и незакрытые `<!--` в текст
// не попадают вообще: они распознаются отдельным куском, а `raw` мы не выводим.
//
// Токены:
//   { type: 'text',    text }                 — текст вне тегов;
//   { type: 'open',    name, attrs, text }    — открывающий тег;
//   { type: 'close',   name, text }           — закрывающий тег;
//   { type: 'comment', text }                 — `<!-- … -->` (или незакрытый);
//   { type: 'decl',    text }                 — `<!DOCTYPE …>`, `<?…>`;
//   { type: 'raw',     text }                 — `<script` без `>` и т.п.
export function tokenizeHtml(html) {
  const src = String(html == null ? '' : html);
  const tokens = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', text: src.slice(textStart, end) });
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    // Комментарий: до `-->`; незакрытый съедает остаток строки.
    if (src.startsWith('<!--', lt)) {
      flushText(lt);
      const end = src.indexOf('-->', lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      tokens.push({ type: 'comment', text: src.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }
    // `<!…>` / `<?…>` — декларации.
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      flushText(lt);
      const gt = src.indexOf('>', lt + 2);
      const stop = gt === -1 ? src.length : gt + 1;
      tokens.push({ type: 'decl', text: src.slice(lt, stop) });
      i = textStart = stop;
      continue;
    }
    const isClose = src[lt + 1] === '/';
    const nameStart = lt + (isClose ? 2 : 1);
    // Имя тега должно начинаться с буквы: `< b` — это текст, а не тег.
    const nameMatch = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(src.slice(nameStart));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const gt = src.indexOf('>', nameStart);
    if (gt === -1) {
      // Незакрытый `<script` — не тег и не текст для вывода: уходит в raw.
      flushText(lt);
      tokens.push({ type: 'raw', text: src.slice(lt) });
      i = textStart = src.length;
      break;
    }
    flushText(lt);
    const name = nameMatch[0].toLowerCase();
    tokens.push({
      type: isClose ? 'close' : 'open',
      name,
      attrs: isClose ? {} : parseTagAttrs(src.slice(nameStart + nameMatch[0].length, gt)),
      text: src.slice(lt, gt + 1),
    });
    i = textStart = gt + 1;
  }
  flushText(src.length);
  return tokens;
}

// Атрибуты внутри открывающего тега (между именем и `>`): сканер, не регулярка.
function parseTagAttrs(s) {
  const attrs = {};
  const src = String(s || '');
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /[\s/]/.test(src[i])) i++;
    if (i >= src.length) break;
    const nameStart = i;
    while (i < src.length && !/[\s=/>]/.test(src[i])) i++;
    if (i === nameStart) { i++; continue; }
    const name = src.slice(nameStart, i).toLowerCase();
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const quote = src[i] === '"' || src[i] === "'" ? src[i] : null;
      if (quote) {
        const end = src.indexOf(quote, i + 1);
        value = src.slice(i + 1, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
      } else {
        const start = i;
        while (i < src.length && !/[\s>]/.test(src[i])) i++;
        value = src.slice(start, i);
      }
    }
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

// Склеить текст из токенов: берём только `text`, теги/комментарии отбрасываем.
export function textFromTokens(tokens) {
  return tokens.filter((t) => t.type === 'text').map((t) => t.text).join('');
}

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

// Убрать HTML-теги из строки, взятой «снаружи» (HTML сайта, чужая разметка).
//
// Это ОБЁРТКА над tokenizeHtml: разбор один, сканером, а не регуляркой — поэтому
// «`<!--` в середине строки» и «`<scr<script>ipt>`» больше не аргумент: внутрь
// вырезанного тега или комментария сканер не заглядывает, а сам он текст
// собирается только из кусков `text`. Ни `<`, ни `<!--` из исходника в
// результате остаться не могут.
//
// ВАЖНО: функция возвращает ПЛОСКИЙ ТЕКСТ, а не HTML. Получатель обязан
// экранировать его через escapeHtml (уведомления уходят с parse_mode:'HTML').
export function stripTags(s) {
  return textFromTokens(tokenizeHtml(s));
}
