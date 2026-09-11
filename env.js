// Конфигурация окружения для sdk (Node-версия).
// Значения берём из process.env, с безопасными дефолтами/предупреждениями.

export const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Обычно api.telegram.org. Можно переопределить (например, зеркало).
export const API_HOST = process.env.API_HOST || 'api.telegram.org';

// Порт HTTP-сервера вебхука.
export const PORT = Number(process.env.PORT || 8080);

// Секрет для проверки запросов на /check (защита крона).
export const CHECK_SECRET = process.env.CHECK_SECRET || '';

// Username бота без @ — нужен для ссылок-диплинков в сообщениях («🔕 отписаться»).
// Значение должно совпадать с реальным username, иначе ссылка откроет чужого бота.
export const BOT_USERNAME = process.env.BOT_USERNAME || 'tickets_sniffer_bot';
