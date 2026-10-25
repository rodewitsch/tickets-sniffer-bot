// Учёт «бюджетов опроса» за один цикл проверки (см. lib/config.js).
//
// Бюджеты — это искусственные ограничения, чтобы один цикл не обошёл пол-сайта:
//   DETAIL_BUDGET         — сколько «деталей событий» можно запросить за цикл;
//                           часть бюджета резервируется под события площадок;
//                           внутри бюджета действует лимит «на чат»
//                           (см. budgetTracker({ perChat }));
//   MAX_CITY_PROBES       — сколько городских проверок делать внутри одной позиции;
//   MAX_VENUE_RESULTS_PER_QUERY — сколько площадок обходить по одному запросу;
//   MAX_VENUE_EVENTS      — сколько событий площадки обрабатывать;
//   VENUE_CRAWL_BUDGET_MS — время на обход площадок по одному запросу;
//   VENUE_QUERY_RECHECK_MS — «троттлинг» повторного обхода площадки.
//
// Модуль ничего не решает — только считает. Модуль держит состояние процесса, поэтому
// чекер обязан вызвать resetBudgetStats() в начале цикла и snapshotBudgetStats() —
// в конце, прежде чем писать строку в check_log.

/**
 * Счётчики утилизации бюджетов за текущий цикл. Все поля числовые и всегда
 * присутствуют — так их удобно писать в БД без «undefined».
 */
export function emptyBudgetStats() {
  return {
    // DETAIL_BUDGET: израсходовано «деталей» (budget.spend) и отказов из-за нехватки.
    detailSpent: 0,
    detailDenied: 0,
    // MAX_CITY_PROBES: сколько городских проверок (запрос на город) реально сделано.
    cityProbes: 0,
    // Сколько раз позиция-событие «афиши» проверялась (независимо от числа городов).
    cityChecks: 0,
    // Самый «жадный» одиночный опрос городов за цикл (0 — опроса не было).
    cityProbesMax: 0,
    // Сколько событий кэша проверено (независимо от типа) — база для «чеков на цикл».
    itemsChecked: 0,
    // Площадки из поиска (notifyFromAfishaVenues → очередь venue_queue).
    queryVenuesTried: 0,      // обошли площадку в этом цикле
    queryVenuesSkipped: 0,    // остались в очереди (срок ещё не пришёл)
    venueQuotaHit: 0,         // сколько раз площадок подошло >= MAX_VENUE_RESULTS_PER_QUERY
    // Очередь площадок (lib/venue-queue.js): сколько новых поставлено, сколько
    // ждало обхода, сколько реально обошли и сколько записей «битые».
    venueQueued: 0,
    venueQueueWaiting: 0,
    venueQueueCrawled: 0,
    venueQueueFailed: 0,
    // Добор: сколько площадок обошли ЗАРАНЕЕ (срок ещё не наступил), чтобы не
    // простаивать свободный бюджет. И сколько площадок отложено из-за нехватки
    // бюджета (курсор не двигаем — вернёмся к тому же месту).
    venueQueueEarly: 0,
    venueQueueDeferred: 0,
    // Уведомления, отправленные без запроса к сайту (событие уже в базе).
    notifiedFree: 0,
    venueCrawlTruncated: 0,   // обход прерван (сумма time + budget, для старых отчётов)
    venueCrawlTimeTruncated: 0,   // обход прерван по VENUE_CRAWL_BUDGET_MS
    venueCrawlBudgetTruncated: 0, // обход прерван из-за исчерпания DETAIL_BUDGET
    venueCrawlDeferred: 0,        // кандидатов не обошли из-за DETAIL_BUDGET (все продолжения)
    venueCrawlMs: 0,          // суммарное время обхода одной серии площадок по запросу
    venueCrawlRuns: 0,        // сколько таких серий было (для среднего)
    // MAX_VENUE_EVENTS: сколько раз обход событий площадки упёрся в лимит.
    venueEventsTruncated: 0,
    // Поиск отдал больше MAX_RESULTS_PER_QUERY результатов (остальные не проверялись).
    resultsTruncated: 0,
    // События площадок (kind='venue'): сколько отдал источник, сколько событий
    // пропущено как прошедшие и сколько упёрлось в лимит.
    venueEventsSeen: 0,
    venueEventsPastSkipped: 0,
    // Кэш поиска (lib/search-cache.js): попадания, промахи и «присоединились к
    // уже идущему запросу». Хиты — это сэкономленные запросы к сайтам.
    searchCacheHits: 0,
    searchCacheMisses: 0,
    searchCacheJoins: 0,
    // Событие «не в продаже» и до старта ещё далеко — перечитывать каждый цикл
    // бессмысленно (см. RECHECK_PRESALE_HORIZON_DAYS).
    presaleSkipped: 0,
    // Отказ в бюджете из-за лимита НА ЧАТ (а не из-за общего исчерпания).
    perChatDenied: 0,
    // Исходы проверки позиций: сколько раз и по какой причине НЕ было сетевого
    // запроса (кэш/свежесть). Это главный ответ на вопрос «почему позиция ничего
    // не проверила» — без него в логах видно только расход бюджета.
    skippedFresh: 0,      // данные свежие (needsRecheck = false)
    noBudget: 0,          // не хватило бюджета (общий или на чат)
    emptyResult: 0,       // источник ничего не нашёл / вернул пусто
    notOnSale: 0,         // событие проверено, но не в продаже
    errorItems: 0,        // позиция упала с ошибкой
  };
}

let stats = emptyBudgetStats();

export function resetBudgetStats() {
  stats = emptyBudgetStats();
  return stats;
}

/** Текущие (живые) счётчики — для отладки и тестов. */
export function currentBudgetStats() {
  return stats;
}

/**
 * Счётчик расходования числового бюджета (DETAIL_BUDGET).
 * Работает как раньше: `budget.left()` больше 0 — можно тратить,
 * `budget.spend(1)` — списать, `budget.trySpend()` — списать, если есть место.
 *
 * Опционально ограничивает расход НА ЧАТ (`perChat`): общий кошелёк остаётся
 * тем же (`total`), но у каждого чата свой лимит. Когда лимит чата исчерпан,
 * трата уходит в `record.perChatDenied()` — это отличает «чату не хватило
 * квоты» от «бюджет цикла кончился» в статистике.
 *
 * @param {number} total        общий бюджет кошелька
 * @param {{perChat?: number}} [opts]
 */
export function budgetTracker(total, { perChat = 0 } = {}) {
  let left = total;
  const spentByChat = new Map();

  const chatLeft = (chatId) => {
    if (!perChat || chatId == null) return Infinity;
    return perChat - (spentByChat.get(chatId) || 0);
  };

  const charge = (n, chatId) => {
    left -= n;
    stats.detailSpent += n;
    if (perChat && chatId != null) {
      spentByChat.set(chatId, (spentByChat.get(chatId) || 0) + n);
    }
  };

  return {
    total,
    perChat,
    left: () => left,
    /** Сколько осталось у конкретного чата (Infinity, если лимита нет). */
    leftFor: (chatId) => chatLeft(chatId),
    spend: (n = 1, chatId = null) => charge(n, chatId),
    /** Можно ли потратить единицу; если нет — счётчик отказов растёт. */
    trySpend: (n = 1, chatId = null) => {
      if (chatLeft(chatId) < n) {
        stats.perChatDenied += 1;
        return false;
      }
      if (left < n) {
        stats.detailDenied += 1;
        return false;
      }
      charge(n, chatId);
      return true;
    },
  };
}

// Аккуратные «накопители»: чекер вызывает их точечно, без зависимости от local-переменных.
export const record = {
  /**
   * Одна проверка городов события: сколько городов реально опрошено. Шаг в 0
   * допустим (нет числового id / конкретный город без id) — тогда запроса к
   * schedule API не было, и «городской проверкой» это не считается: иначе
   * cityChecks разбавлялся бы пустыми проверками, а perCheck в отчёте врал.
   */
  cityProbe: (n = 1) => {
    const probes = Math.max(0, Math.trunc(Number(n) || 0));
    if (!probes) return;
    stats.cityChecks += 1;
    stats.cityProbes += probes;
    if (probes > stats.cityProbesMax) stats.cityProbesMax = probes;
  },
  /**
   * Позиция-событие «афиши» проверялась по городам (независимо от числа городов).
   * Вызывается из withCityProbe, в том числе при ошибке запроса — иначе
   * «городских проверок» в статистике было бы меньше, чем реальных обращений.
   * Ранее метод отсутствовал, хотя вызывался: любая проверка события «афиши»
   * падала с TypeError и попадала в failed.
   */
  cityChecks: () => { stats.cityChecks += 1; },
  itemChecked: () => { stats.itemsChecked += 1; },
  queryVenueTried: () => { stats.queryVenuesTried += 1; },
  queryVenueSkipped: (n = 1) => { stats.queryVenuesSkipped += Math.max(0, Number(n) || 0); },
  venueQuotaHit: () => { stats.venueQuotaHit += 1; },
  /** В очередь поставлены новые площадки (найдены поиском). */
  queryVenueEnqueued: (n = 1) => { stats.venueQueued += Math.max(0, Number(n) || 0); },
  /** Сколько записей ждало обхода к концу цикла (глубина «хвоста»). */
  venueQueueWaiting: (n = 0) => { stats.venueQueueWaiting = Math.max(0, Number(n) || 0); },
  /** Сколько площадок очередь реально обошла за цикл. */
  venueQueueCrawled: (n = 1) => { stats.venueQueueCrawled += Math.max(0, Number(n) || 0); },
  /** Площадка не открылась/не разобралась — отложена с backoff. */
  venueQueueFailed: () => { stats.venueQueueFailed += 1; },
  /** Площадки обойдены ЗАРАНЕЕ (срок ещё не наступил) — чтобы не простаивать. */
  venueQueueEarly: (n = 1) => { stats.venueQueueEarly += Math.max(0, Number(n) || 0); },
  /** Площадка отложена: не хватило DETAIL_BUDGET на её события (курсор сохранён). */
  venueQueueDeferred: () => { stats.venueQueueDeferred += 1; },
  /**
   * Уведомление отправлено БЕЗ запроса к сайту: событие уже в базе и в продаже,
   * а перечитывать страницу не нужно. Такие отправки не должны зависеть от
   * DETAIL_BUDGET — иначе найденная продажа ждёт следующего цикла.
   */
  notifiedFree: () => { stats.notifiedFree += 1; },
  resultsTruncated: () => { stats.resultsTruncated += 1; },
  /**
   * Обход площадок прерван. Причина обязательна: 'time' — упёрлись в
   * VENUE_CRAWL_BUDGET_MS, 'budget' — кончился DETAIL_BUDGET. Счётчики разные,
   * иначе в отчёте «прерван по времени» почти всегда врёт.
   */
  venueCrawlTruncated: (reason = 'time') => {
    stats.venueCrawlTruncated += 1;
    if (reason === 'budget') stats.venueCrawlBudgetTruncated += 1;
    else stats.venueCrawlTimeTruncated += 1;
  },
  /** Кандидат/продолжение не обошли из-за исчерпанного DETAIL_BUDGET (отложено). */
  venueCrawlDeferred: () => { stats.venueCrawlDeferred += 1; },
  venueCrawlRun: (ms) => {
    stats.venueCrawlRuns += 1;
    stats.venueCrawlMs += Math.max(0, Number(ms) || 0);
  },
  venueEventsTruncated: () => { stats.venueEventsTruncated += 1; },
  venueEventsSeen: (n) => { stats.venueEventsSeen += Math.max(0, Number(n) || 0); },
  /**
   * Событие площадки пропущено как прошедшее. Принимает число (одна площадка
   * отдаёт пачку прошедших сеансов — считать их по одному было бы дорого).
   */
  venueEventPastSkipped: (n = 1) => { stats.venueEventsPastSkipped += Math.max(0, Number(n) || 0); },
  /** Событие далеко в будущем и не в продаже — перечитывать не нужно. */
  presaleSkipped: () => { stats.presaleSkipped += 1; },
  /** Исходы проверки позиций (нужны для разбора «почему не проверилось»). */
  skippedFresh: () => { stats.skippedFresh += 1; },
  noBudget: () => { stats.noBudget += 1; },
  emptyResult: () => { stats.emptyResult += 1; },
  notOnSale: () => { stats.notOnSale += 1; },
  errorItem: () => { stats.errorItems += 1; },
  /**
   * Копирует счётчики кэша поиска (сбрасываются внутри search-cache, чтобы не
   * держать связность модулей). Вызывается чекером в конце цикла.
   */
  searchCache: ({ hits = 0, misses = 0, joins = 0 } = {}) => {
    stats.searchCacheHits = hits;
    stats.searchCacheMisses = misses;
    stats.searchCacheJoins = joins;
  },
};

/** Снимок счётчиков (копия) — кладётся в check_log. */
export function snapshotBudgetStats() {
  return { ...stats };
}
