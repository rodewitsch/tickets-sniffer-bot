// Чтение/запись служебных значений в таблице `meta` (key → value).
//
// Раньше эти две функции были байт-в-байт скопированы в lib/checker.js и
// lib/watchdog.js. Копии со временем разойдутся (одну поправят, вторую — нет),
// поэтому теперь точка одна.
import db from '../db.js';
import { meta } from '../schema.js';
import { eq } from '../db.js';

export async function getMeta(key) {
  const row = await db.select().from(meta).where(eq(meta.key, key)).get();
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}
