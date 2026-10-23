// Учёт «бюджетов опроса» за один цикл проверки (см. lib/config.js).
//
// Бюджеты — это искусственные ограничения, чтобы один цикл не обошёл пол-сайта:
//   DETAIL_BUDGET         — сколько «деталей событий» можно запросить за цикл;
//                           часть бюджета резервируется под события площадок;
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
    // Площадки из поиска (notifyFromAfishaVenues).
    queryVenuesTried: 0,      // обошли площадку в этом цикле
    queryVenuesSkipped: 0,    // не обошли: VENUE_QUERY_RECHECK_MS ещё не истёк
    venueQuotaHit: 0,         // сколько раз площадок подошло >= MAX_VENUE_RESULTS_PER_QUERY
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
 * Заменяет прежний budgetTracker из checker.js, попутно считая утилизацию.
 * Работает как до: `budget.left()` больше 0 — можно тратить, `budget.spend(1)`.
 */
export function budgetTracker(total) {
  let left = total;
  return {
    total,
    left: () => left,
    spend: (n = 1) => {
      left -= n;
      stats.detailSpent += n;
    },
    /** Можно ли потратить единицу; если нет — счётчик отказов растёт. */
    trySpend: (n = 1) => {
      if (left <= 0) {
        stats.detailDenied += 1;
        return false;
      }
      left -= n;
      stats.detailSpent += n;
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
  itemChecked: () => { stats.itemsChecked += 1; },
  queryVenueTried: () => { stats.queryVenuesTried += 1; },
  queryVenueSkipped: () => { stats.queryVenuesSkipped += 1; },
  venueQuotaHit: () => { stats.venueQuotaHit += 1; },
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
  venueEventPastSkipped: () => { stats.venueEventsPastSkipped += 1; },
};

/** Снимок счётчиков (копия) — кладётся в check_log. */
export function snapshotBudgetStats() {
  return { ...stats };
}
