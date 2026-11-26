// Кэш результатов поиска по ключевому слову.
//
// Зачем: поиск — самая дорогая часть цикла (страница результатов + разбор), а
// один и тот же запрос проверяется каждый цикл (15–30 мин) и почти никогда не
// меняется за это время. Два пользователя с одинаковым ключевиком («РТБД»,
// «Театр») тоже дублировали бы запрос. Кэш живёт в памяти процесса и общий для
// всех позиций: ключ — `<source>:<нормализованный запрос>`.
//
// Срок жизни короткий (SEARCH_CACHE_TTL_MS): результат поиска — это «какие
// события вообще есть», а не наличие билетов. Наличие всё равно проверяется
// детальным запросом по каждому событию, поэтому устаревший на 10 минут список
// не приводит к пропущенному уведомлению — новое событие подхватится со
// следующего промаха кэша.
//
// Одновременные запросы схлопываются (in-flight de-duplication): если два
// ключевика ищутся в одном цикле, второй ждёт первый запрос, а не дублирует его.
import { SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX_ENTRIES } from './config.js';
import { normText } from './util.js';

// source → Map<queryKey, { value, expiresAt }>
const store = new Map();
// source → Map<queryKey, Promise>
const inflight = new Map();

// Счётчики для check_log (сбрасываются чекером в начале цикла, см. lib/budget.js).
const stats = { hits: 0, misses: 0, joins: 0 };

export function resetSearchCacheStats() {
  stats.hits = 0;
  stats.misses = 0;
  stats.joins = 0;
}

export function snapshotSearchCacheStats() {
  return { ...stats };
}

function queryKey(query) {
  return normText(String(query || '').trim());
}

function bucket(source) {
  let m = store.get(source);
  if (!m) {
    m = new Map();
    store.set(source, m);
  }
  return m;
}

// Вытеснение: Map хранит порядок вставки, поэтому первый ключ — самый старый.
function prune(m) {
  while (m.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/**
 * Выполняет поиск с кэшированием.
 *
 * @param {string} source   'afisha' | 'ticketpro' | 'bezkassira'
 * @param {string} query    ключевое слово
 * @param {() => Promise<any>} fn  реальный запрос к источнику
 * @param {{cache?: boolean}} [opts]  cache:false — выполнить, но НЕ запоминать
 *        (например, источник на паузе вернул пусто из-за сбоя: это не «нет билетов»)
 * @returns {Promise<any>} результат поиска (из кэша или свежий)
 */
export async function cachedSearch(source, query, fn, { cache = true } = {}) {
  const key = queryKey(query);
  if (!key || !cache) return fn();

  const m = bucket(source);
  const hit = m.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) {
    stats.hits += 1;
    // Освежаем позицию в Map, чтобы вытеснялся действительно самый старый.
    m.delete(key);
    m.set(key, hit);
    return hit.value;
  }

  const pending = inflight.get(source)?.get(key);
  if (pending) {
    stats.joins += 1;
    return pending;
  }

  stats.misses += 1;
  let flight;
  flight = (async () => {
    try {
      const value = await fn();
      m.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
      prune(m);
      return value;
    } finally {
      const bucketInflight = inflight.get(source);
      if (bucketInflight) {
        bucketInflight.delete(key);
        // Пустую «корзину» убираем: иначе inflight держит по одной Map на каждый
        // встреченный source вечно (утечка «на единицы», но бесплатная правка).
        if (!bucketInflight.size) inflight.delete(source);
      }
    }
  })();

  let bi = inflight.get(source);
  if (!bi) {
    bi = new Map();
    inflight.set(source, bi);
  }
  bi.set(key, flight);
  return flight;
}

// ── Ротация окна выдачи поиска ──────────────────────────────────────────────
//
// Задача: поиск отдаёт до 50 результатов (у ticketpro) и больше (у bezkassira),
// а проверять детально каждый — дорого (по странице на событие). Поэтому окно
// ограничено MAX_RESULTS_PER_QUERY. Раньше код брал ВСЕГДА первые 10, то есть
// хвост выдачи не проверялся никогда: в проде это давало 325–380 потерянных
// результатов в сутки и росло вместе с базой.
//
// Ротация по образцу venue_queue: у каждой пары (источник, запрос) есть курсор,
// который сдвигается на размер окна за просмотр. За ceil(len / window) циклов
// проверяется ВСЯ выдача, затем курсор возвращается к началу.
//
// Важно: размер окна НЕ растёт — за цикл тратится столько же бюджетных единиц,
// меняется только то, ЧЬИ результаты попадают в окно. Нагрузка на сайты
// остаётся прежней (поиск один, страницы — те же 10 за цикл).
//
// Состояние живёт в памяти процесса и теряется при перезапуске: это не потеря
// данных, а лишь «с какого места продолжить» — повторим с начала.
//
// Счётчики покрытия для отчёта: скольких событий выдачи мы коснулись в этом
// цикле и сколько кругов по выдаче уже прошли.
const ROTATION_MAX_KEYS = 500;
const rotationCursors = new Map();
const coverage = { rotated: 0, full: 0, tailLost: 0 };

export function resetRotationStats() {
  coverage.rotated = 0;
  coverage.full = 0;
  coverage.tailLost = 0;
}

export function snapshotRotationStats() {
  return { ...coverage };
}

function rotationKey(source, query) {
  return `${source}:${queryKey(query)}`;
}

/**
 * Сдвигающееся окно по результатам поиска.
 *
 * @param {string} source  'afisha' | 'ticketpro' | 'bezkassira'
 * @param {string} query   ключевое слово (нормализуется)
 * @param {number} len     длина полной выдачи
 * @param {number} window  размер окна (MAX_RESULTS_PER_QUERY)
 * @returns {{ start: number, end: number, wrapped: boolean }}
 *   start/end — границы окна в массиве выдачи (для slice), wrapped — курсор
 *   перешагнул конец и вернулся к началу (выдача пройдена целиком).
 */
export function rotationWindow(source, query, len, window) {
  const size = Math.max(1, Math.trunc(window) || 1);
  if (!Number.isFinite(len) || len <= size) {
    // Всё влезает в одно окно: ротация не нужна, счётчик «ротаций» не трогаем.
    // «Выдачу прошли целиком» считаем только когда в ней что-то есть.
    const n = Math.max(0, Math.trunc(len) || 0);
    return { start: 0, end: n, wrapped: false };
  }
  const key = rotationKey(source, query);
  const prev = rotationCursors.get(key) || 0;
  // Курсор мог «уехать» дальше текущей длины выдачи (выдача ужалась) — нормализуем.
  const start = ((prev % len) + len) % len;
  const next = start + size;
  const wrapped = next >= len;
  // Сохраняем следующую позицию (с учётом возможного уменьшения выдачи при
  // следующем круге — нормализуем ещё раз при чтении).
  rotationCursors.set(key, next);
  // Ограничиваем память: при переполнении сбрасываем самые старые ключи
  // (Map хранит порядок вставки).
  if (rotationCursors.size > ROTATION_MAX_KEYS) {
    const oldest = rotationCursors.keys().next().value;
    rotationCursors.delete(oldest);
  }
  coverage.rotated += 1;
  if (wrapped) coverage.full += 1;
  // Хвост текущего окна за пределами массива обрезается — это НОРМА (последнее
  // окно короче), но считаем отдельно, чтобы видеть, сколько последних
  // результатов ещё не просмотрено до конца круга.
  const end = Math.min(len, next);
  return { start, end, wrapped };
}

// Полная очистка ротации (для тестов).
export function clearRotation() {
  rotationCursors.clear();
}
