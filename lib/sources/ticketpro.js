// Источник Ticketpro.by: серверный рендер (Yii), события размечены JSON-LD
// прямо в выдаче поиска и на страницах событий.
import { httpGet } from '../http.js';
import { extractJsonLd } from '../jsonld.js';
import { normalizeLdEvent } from '../normalize.js';

const SITE = 'https://www.ticketpro.by';

function eventsFromHtml(html) {
  const out = [];
  const seen = new Set();
  for (const ld of extractJsonLd(html)) {
    const type = ld['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => String(t).toLowerCase() === 'event')) continue;
    const ev = normalizeLdEvent(ld, 'ticketpro');
    if (!ev || seen.has(ev.uid)) continue;
    seen.add(ev.uid);
    out.push(ev);
  }
  return out;
}

// Поиск по ключевому слову. Сразу отдаёт полные данные (цены, наличие, картинка).
export async function searchTicketpro(query) {
  const url = `${SITE}/rasshirennyj-poisk/?event_or_artist=${encodeURIComponent(query)}`;
  const { status, text } = await httpGet(url);
  if (status !== 200 || !text) return [];
  return eventsFromHtml(text);
}

// Детали одного события по его странице.
export async function fetchTicketproEventDetails(eventUrl) {
  const { status, text } = await httpGet(eventUrl);
  if (status !== 200 || !text) return null;
  const evs = eventsFromHtml(text);
  return evs[0] || null;
}
