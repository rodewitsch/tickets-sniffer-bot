// Общие настройки бота. Отредактируйте под себя перед деплоем.

// URL Mini App (GitHub Pages). Подробнее — в README и .github/workflows/pages.yml.
// ?v=2 — версионный параметр для сброса кэша клиента.
export const MINIAPP_URL = 'https://rodewitsch.github.io/tickets-sniffer-bot/?v=3';

// Минимальный интервал между автоматическими циклами проверки (минуты).
export const CHECK_INTERVAL_MIN = 10;

// Бюджет запросов деталей событий за один цикл проверки.
export const DETAIL_BUDGET = 12;

// Таймаут одного HTTP-запроса к билетным сайтам (мс).
export const FETCH_TIMEOUT_MS = 15000;

// Источники билетов.
export const SOURCES = {
  afisha: { id: 'afisha', label: 'Афиша (24afisha.by / bycard.by)' },
  ticketpro: { id: 'ticketpro', label: 'Ticketpro.by' },
};
