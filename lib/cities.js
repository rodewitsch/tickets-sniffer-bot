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

/**
 * Человекочитаемая метка города по слагу. Если слага нет в каталоге — приводим
 * к читаемому виду (первая буква заглавная). Для 'all' возвращает «все города».
 */
export function cityLabel(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  if (s === 'all') return ALL_CITIES_LABEL;
  if (CITY_LABELS[s]) return CITY_LABELS[s];
  // Fallback: 'brest' → 'Брест'
  return s.charAt(0).toUpperCase() + s.slice(1);
}
