// Общие настройки бота. Отредактируйте под себя перед деплоем.

// URL Mini App (GitHub Pages). Подробнее — в README и .github/workflows/pages.yml.
// ?v=5 — версионный параметр для сброса кэша клиента.
// Добавьте &api=https://ВАШ-ДОМЕН (TICKET_DOMAIN с droplet), чтобы включить выбор
// городов события в мини-приложении (бот отдаёт список через /api/event-cities).
export const MINIAPP_URL = 'https://rodewitsch.github.io/tickets-sniffer-bot/?v=6&api=https://tickets-sniffer-bot.rodevich.com';

// Минимальный интервал между автоматическими циклами проверки (минуты).
export const CHECK_INTERVAL_MIN = 10;

// Бюджет запросов деталей событий за один цикл проверки.
export const DETAIL_BUDGET = 12;

// Максимум городских страниц события, которые проверяем за один цикл в режиме
// «все города». Идём по городам до первого найденного onSale (или до лимита).
export const MAX_CITY_PROBES = 10;

// Таймаут одного HTTP-запроса к билетным сайтам (мс).
export const FETCH_TIMEOUT_MS = 15000;

// Источники билетов.
export const SOURCES = {
  afisha: { id: 'afisha', label: 'Афиша (24afisha.by / bycard.by)' },
  ticketpro: { id: 'ticketpro', label: 'Ticketpro.by' },
};
