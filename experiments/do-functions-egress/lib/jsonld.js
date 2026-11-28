// Извлечение schema.org JSON-LD из HTML страниц билетных сайтов.
// Часть блоков на сайтах содержит битый JSON (неэкранированные кавычки в
// описаниях), поэтому после неудачного parse достаем нужные поля регэкспами.

export function extractJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) if (item && typeof item === 'object') out.push(item);
    } catch {
      const salvaged = salvageEvent(raw);
      if (salvaged) out.push(salvaged);
    }
  }
  return out;
}

export function findEventLd(ldList) {
  for (const item of ldList) {
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => String(t).toLowerCase() === 'event')) return item;
  }
  return null;
}

function field(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\(["\\/bfnrt])/g, (s, c) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c) : null;
}

// Вытаскиваем из битого JSON-LD минимально необходимый набор полей события.
function salvageEvent(raw) {
  const url = field(raw, 'url');
  const name = field(raw, 'name');
  if (!url && !name) return null;
  const ev = { '@type': 'Event', _salvaged: true };
  if (url) ev.url = url;
  if (name) ev.name = name;
  const startDate = field(raw, 'startDate');
  if (startDate) ev.startDate = startDate;
  const offersChunk = raw.match(/"offers"\s*:\s*\{([\s\S]*?)\}\s*[,}]/);
  if (offersChunk) {
    const o = offersChunk[1];
    const offers = { '@type': 'AggregateOffer' };
    const avail = field(o, 'availability');
    if (avail) offers.availability = avail;
    const price = field(o, 'price');
    if (price) offers.price = price;
    const low = field(o, 'lowPrice');
    if (low) offers.lowPrice = low;
    const high = field(o, 'highPrice');
    if (high) offers.highPrice = high;
    const cur = field(o, 'priceCurrency');
    if (cur) offers.priceCurrency = cur;
    ev.offers = offers;
  }
  const image = field(raw, 'image');
  if (image) ev.image = Array.isArray(image) ? image : [image];
  const venueChunk = raw.match(/"location"\s*:\s*\{([\s\S]*?)\}\s*[,}]/);
  if (venueChunk) {
    const vname = field(venueChunk[1], 'name');
    if (vname) ev.location = { '@type': 'Place', name: vname };
  }
  return ev;
}
