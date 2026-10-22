// Каталог городов Беларуси (slug ↔ человекочитаемая метка) для фильтрации
// «Афиши» (24afisha.by / bycard.by). Используется, чтобы отображать город в
// списке отслеживания и фильтровать события Ticketpro по городу.
//
// Slug — это сегмент города в URL-пути сайта (напр. `/ru/brest/event/...`).
// Метка — русское название с заглавной буквы, как в интерфейсе сайта.

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
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
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
