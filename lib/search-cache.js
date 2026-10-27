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
 * @returns {Promise<any>} результат поиска (из кэша или свежий)
 */
export async function cachedSearch(source, query, fn) {
  const key = queryKey(query);
  if (!key) return fn();

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

// Полная очистка (для тестов / ручной инвалидации).
export function clearSearchCache() {
  store.clear();
  inflight.clear();
  resetSearchCacheStats();
}
