// Небольшие общие хелперы для источников (lib/sources/*).
// Держим их здесь, а не в каждом файле, чтобы ограничение параллелизма и
// нормализация были ОДНИМИ для всех сайтов.

/**
 * Запускает `fn` для каждого элемента с не более `limit` одновременных задач.
 * Возвращает массив результатов в исходном порядке (упавшая задача → null).
 *
 * Нужен там, где иначе `Promise.all` выстреливает десятком запросов к одному
 * сайту сразу (риск бана по IP).
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  };
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
