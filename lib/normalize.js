// Приведение schema.org Event (JSON-LD) к единой модели события.
// 24afisha.by и bycard.by — общий бэкенд (общая база, одинаковые slug), поэтому
// оба считаются одним «источником» afisha. Домен страницы определяет, на какой
// сайт вести пользователя.
import { parseDate, formatDateRu } from './util.js';

const AFISHA_ORIGIN = 'https://24afisha.by';
const BYCARD_ORIGIN = 'https://bycard.by';
const TICKETPRO_ORIGIN = 'https://www.ticketpro.by';

function absUrl(u, origin) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return origin + (u.startsWith('/') ? '' : '/') + u;
}

function firstImage(ld, origin) {
  let img = ld.image;
  if (Array.isArray(img)) img = img[0];
  if (img && typeof img === 'object') img = img.url || img.contentUrl;
  return absUrl(img, origin);
}

// Определяет домен «афиши» по URL страницы, с которой пришёл JSON-LD.
function afishaOriginForPage(pageUrl) {
  return /bycard\.by/i.test(pageUrl) ? BYCARD_ORIGIN : AFISHA_ORIGIN;
}

/**
 * @param {object} ld      schema.org Event из JSON-LD
 * @param {string} source  'afisha' | 'ticketpro'
 * @param {string} pageUrl URL страницы, с которой извлечён JSON-LD.
 *   Для afisha это и есть канонический url события (у bycard в ld.url числовой
 *   id, а не slug), для ticketpro — тоже страница события.
 */
export function normalizeLdEvent(ld, source, pageUrl = null) {
  const origin = source === 'afisha'
    ? afishaOriginForPage(pageUrl || (ld.url || ''))
    : TICKETPRO_ORIGIN;

  // Канонический url: для afisha берём pageUrl (он содержит читабельный slug),
  // иначе — абсолютную версию ld.url.
  const url = source === 'afisha' && pageUrl ? pageUrl : absUrl(ld.url, origin);
  if (!url || !ld.name) return null;

  const uid = source === 'afisha' ? afishaSlugFromUrl(url) : url.replace(/[?#].*$/, '');

  const offers = ld.offers || {};
  const availability = String(offers.availability || '').toLowerCase();
  const onSale = availability.includes('instock') || availability.includes('presale');
  const cancelled = String(ld.eventStatus || '').toLowerCase().includes('cancelled');

  const pd = parseDate(ld.startDate);

  let city = null;
  if (source === 'afisha') {
    // Предпочитаем конкретный город из JSON-LD (у bycard это «Минск» с заглавной),
    // иначе — сегмент города из URL-пути.
    const locality = ld.location?.address?.addressLocality;
    if (locality) {
      city = String(locality).trim() || null;
    } else {
      const m = url.match(/\/(?:ru\/([a-z\-]+)\/event|afisha\/([a-z\-]+)\/(?:event|concert|show|other))/);
      city = (m && (m[1] || m[2])) || null;
    }
  } else {
    city = ld.location?.address?.addressLocality || null;
  }

  return {
    source,
    uid,
    title: String(ld.name).trim(),
    venue: ld.location?.name || null,
    city,
    dateText: pd ? formatDateRu(pd.ts, pd.hasTime) : String(ld.startDate || ''),
    startsAt: pd ? pd.ts : null,
    url,
    buyUrl: source === 'afisha' ? `${url.split('#')[0]}#tickets` : url,
    image: firstImage(ld, origin),
    priceFrom: offers.lowPrice || offers.price || null,
    priceTo: offers.highPrice || null,
    currency: offers.priceCurrency || 'BYN',
    onSale,
    status: cancelled ? 'cancelled' : onSale ? 'onsale' : 'nosale',
  };
}

// Извлекает slug события из URL обоих форматов «афиши»:
//   /ru/<city>/event/<slug>          (24afisha.by)
//   /afisha/<city>/<type>/<slug>     (bycard.by, type: event|concert|show|…)
export function afishaSlugFromUrl(url) {
  const s = String(url);
  const m = s.match(/\/(?:event|events)\/([^\/?#]+)/)
    || s.match(/\/afisha\/[a-z\-]+\/[a-z\-]+\/([^\/?#]+)/);
  return m ? m[1] : s.replace(/[?#].*$/, '');
}
