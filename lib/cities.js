// Каталог городов Беларуси (slug ↔ человекочитаемая метка) для фильтрации
// «Афиши» (24afisha.by / bycard.by). Используется, чтобы отображать город в
// списке отслеживания и фильтровать события Ticketpro по городу.
//
// Slug — это сегмент города в URL-пути сайта (напр. `/ru/brest/event/...`).
// Метка — русское название с заглавной буквы, как в интерфейсе сайта.
import { normText } from './util.js';

// Основные города. Для неизвестных слагов есть fallback в cityLabel().
export const CITY_LABELS = {
  minsk: 'Минск',
  brest: 'Брест',
  vitebsk: 'Витебск',
  gomel: 'Гомель',
  mogilev: 'Могилёв',
  grodno: 'Гродно',
  bobruisk: 'Бобруйск',
  baranovichi: 'Барановичи',
  novopolock: 'Новополоцк',
  borisov: 'Борисов',
  soligorsk: 'Солигорск',
  mozyry: 'Мозырь',
  luninec: 'Лунинец',
  stolin: 'Столин',
  pinsk: 'Пинск',
  orsha: 'Орша',
  lida: 'Лида',
  molodechno: 'Молодечно',
  zhodino: 'Жодино',
  rechyca: 'Речица',
  svetlogorsk: 'Светлогорск',
  slonim: 'Слоним',
  kobrin: 'Кобрин',
  sluck: 'Слуцк',
  glubokoe: 'Глубокое',
  postavy: 'Поставы',
  dobrush: 'Добруш',
  krichev: 'Кричев',
  osipovichi: 'Осиповичи',
  zhabinka: 'Жабинка',
  petrikov: 'Петриков',
  rogachev: 'Рогачёв',
  elsk: 'Ельск',
  jitkovichi: 'Житковичи',
  gorodok: 'Городок',
  kleck: 'Клецк',
  volkovysk: 'Волковыск',
  smorgon: 'Сморгонь',
  jlobin: 'Жлобин',
  kalinkovichi: 'Калинковичи',
  loyev: 'Лоев',
  narovlya: 'Наровля',
  brahin: 'Брагин',
  chachersk: 'Чечерск',
  vetka: 'Ветка',
  korma: 'Корма',
  pruzhany: 'Пружаны',
  ivanovo: 'Иваново',
  dzerzhinsk: 'Дзержинск',
  fanipol: 'Фаниполь',
  zaslavl: 'Заславль',
  bykhov: 'Быхов',
  kostyukovichi: 'Костюковичи',
  klimovichi: 'Климовичи',
  mstislavl: 'Мстиславль',
  chausy: 'Чаусы',
  cherikov: 'Чериков',
  shklov: 'Шклов',
  gorki: 'Горки',
  braslav: 'Браслав',
  slawharad: 'Славгород',
  krugloye: 'Круглое',
};

// «Все города» — служебная метка для режима слежения city='all'.
export const ALL_CITIES_LABEL = 'все города';

// Слаги городов по убыванию длины — для поиска города в конце слага.
const CITY_SLUGS_BY_LEN = Object.keys(CITY_LABELS).sort((a, b) => b.length - a.length);

// Метка → слаг (для нормализации «Минск» → minsk). Также ловим написание без «ё».
const SLUG_BY_LABEL = (() => {
  const map = new Map();
  for (const [slug, label] of Object.entries(CITY_LABELS)) {
    map.set(normCityKey(label), slug);
    map.set(normCityKey(slug), slug);
  }
  return map;
})();

function normCityKey(s) {
  // Та же нормализация, что у normText в lib/util.js (одна реализация).
  return normText(s);
}

/**
 * Приводит город к слаг-канону: 'Минск' / 'минск' / 'minsk' → 'minsk'.
 * Возвращает null для пустого значения; для служебных ('all') — 'all' как есть.
 * Если города нет в каталоге, возвращает нормированную строку как есть, чтобы
 * не терять данные источника (например, новый город, которого нет в CITY_LABELS).
 */
export function citySlugFrom(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (s === 'all') return 'all';
  return SLUG_BY_LABEL.get(normCityKey(s)) || s;
}

/**
 * Город из слага площадки «афиши». В слаге площадки зашит город
 * (kinoteatr-mir-brest-brest → brest, kinoteatr-mir-minsk → minsk), поэтому
 * одноимённые площадки в разных городах («Мир» в Минске/Бресте/Витебске/Гомеле)
 * различимы. Возвращает '' — если город определить не удалось.
 */
export function venueCityFromSlug(slug) {
  const s = String(slug || '').toLowerCase();
  if (!s) return '';
  for (const c of CITY_SLUGS_BY_LEN) {
    if (s === c || s.endsWith('-' + c)) return c;
  }
  return '';
}

/**
 * Подходит ли событие позиции с городом `watchCity`.
 *
 * Одна реализация для ВСЕХ мест, где раньше сравнение копировали вручную
 * (`normText(ev.city) !== normText(cityLabel(city))`). Копии расходились, и
 * обход площадок (`runVenueCrawl`) вообще не проверял город получателя: гомельский
 * спектакль пришёл по «минской» подписке на «Театр».
 *
 * Правила:
 *   • `watchCity` пуст / 'all' → годится любой город (город из URL события);
 *   • у события известен город слагом/меткой («gomel» / «Минск») — сверяем слаги;
 *   • иначе берём город из ссылки события (`/ru/<city>/event/…`);
 *   • иначе ищем метку города в названии площадки/события
 *     («Гомельский городской молодёжный театр»);
 *   • ничего не известно → НЕ фильтруем: источники часто не отдают город вовсе,
 *     а потерять уведомление хуже, чем показать лишнее.
 *
 * @param {string|null|undefined} watchCity город позиции (слаг или метка)
 * @param {object} ev событие (поле `city`, иначе `url`/`venue`/`title`)
 * @returns {boolean}
 */
export function cityMatchesWatch(watchCity, ev) {
  const want = citySlugFrom(watchCity);
  if (!want || want === 'all') return true;
  if (!ev) return false;

  // 1. Город события слагом/меткой.
  const evCity = citySlugFrom(ev.city);
  if (evCity && evCity !== 'all') return normCityKey(evCity) === normCityKey(want);

  // 2. Город зашит в ссылку события: /ru/<city>/event/..., /afisha/<city>/event/...
  const fromUrl = /\/ru\/([a-z\-]+)\/(?:event|events)\//.exec(String(ev.url || ''))?.[1]
    || /\/afisha\/([a-z\-]+)\/event\//.exec(String(ev.url || ''))?.[1];
  if (fromUrl) return normCityKey(citySlugFrom(fromUrl) || fromUrl) === normCityKey(want);

  // 3. Город только в тексте («Гомельский городской молодёжный театр»).
  const label = normCityKey(CITY_LABELS[want] || want);
  if (!label || label.length < 4) return true; // «Орша», «Лида» — по подстроке не угадываем
  const hay = normCityKey(`${ev.venue || ''} ${ev.title || ''}`);
  if (!hay) return true;
  return hay.includes(label);
}

/**
 * Человекочитаемая метка города по слагу. Если слага нет в каталоге — приводим
 * к читаемому виду (первая буква заглавная). Для 'all' возвращает «все города».
 */
export function cityLabel(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  if (s === 'all') return ALL_CITIES_LABEL;
  const canon = citySlugFrom(s);
  if (CITY_LABELS[canon]) return CITY_LABELS[canon];
  // Fallback: 'brest' → 'Брест'
  return canon.charAt(0).toUpperCase() + canon.slice(1);
}
