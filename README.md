# 🎫 Билетный радар — Telegram Mini App бот

Telegram-бот с мини-приложением, который следит за появлением билетов на
**24afisha.by**, **bycard.by** и **ticketpro.by** и присылает уведомление в чат,
как только на интересующее вас событие появляются билеты — с превью, ценой и
ссылкой на покупку.

- **Хостинг бота** — **DigitalOcean Droplet / любой VPS**: обычный Node.js-сервис в Docker Compose.
  Пошаговая инструкция — в [`DEPLOY_DROPLET.md`](DEPLOY_DROPLET.md).
- **HTTPS** — автоматически через Caddy (в compose, Let's Encrypt).
- **Хостинг Mini App** — GitHub Pages (`.github/workflows/pages.yml`).
- **Проверка билетов** — каждые `CHECK_INTERVAL_MIN` минут через docker-сервис `cron`.
- **Автодеплой** — GitHub Actions → SSH → `docker compose up -d --build`.

## Возможности

- Отслеживание **ключевого слова / исполнителя** — просто отправьте его боту сообщением.
- Отслеживание **конкретного события** или **площадки** — через мини-приложение.
- **Выбор города** — при добавлении события/слова/площадки можно указать конкретный город
  (Минск, Брест, …) или «все города». Наличие билетов проверяется **по городу**: одно и то же
  событие может быть в продаже в одном городе и недоступно в другом.
- Уведомление с фото-превью, ценой и кнопкой покупки (все источники на выбор).
- Однократное уведомление на событие (без дублей между агрегаторами).
- Команды: `/start`, `/list`, `/check`, `/help`.

### Как работает выбор города

События 24afisha.by / bycard.by живут по одному URL на город
(`/ru/<город>/event/<slug>`), и расписание/наличие билетов у них различается между городами.
При добавлении позиции бот (или мини-приложение) предлагает город. Наличие по выбранному
городу берётся из schedule API «Афиши» (`/api/v2/schedule/events/<id>?cityId=<N>`) — надёжно
для кино и любых событий с сеансами.

- `city` NULL — город не выбран (по умолчанию город события из его URL).
- `city` = `brest` — следить только за Брестом.
- `city` = `all` — следить во всех городах (уведомить, если билеты появятся хоть где-то).

## Структура

| Путь | Назначение |
|------|-----------|
| `schema.js` | Схема БД (Drizzle `sqliteTable`). |
| `db.js` | Слой SQLite: `drizzle(better-sqlite3)` + ре-экспорт операторов. |
| `drizzle/` | Миграции (генерирует `drizzle-kit`, применяет `migrate`). |
| `api.js` | Telegram Bot API (`api.<method>` → unwrapped, `BotApiError`). |
| `handlers/` | Вебхук-хендлеры (`message`, `callback_query`), вызываются из `server.js`. |
| `lib/` | Бизнес-логика: `checker`, `watch`, `webapp`, `menus`, `sources/{afisha,ticketpro}` и др. |
| `server.js` | HTTP-сервер вебхука (`/webhook`, `/check`, `/health`). |
| `cron.js` | Демон проверки билетов (docker-сервис `cron`). |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Контейнеры + HTTPS. |
| `miniapp/` | Статика Telegram Mini App (GitHub Pages). |
| `.github/workflows/` | Автодеплой на droplet + публикация Mini App. |

## Настройка

### 1. Создать бота

В **@BotFather**: создайте бота и получите **bot token** (обычный, НЕ
`TGCLOUD_TOKEN`). Также в этом же боте при желании укажите **Menu Button** — ссылку
на Mini App (см. п. 3).

### 2. Задеплоить бота на Droplet

Актуальный и единственный способ — **DigitalOcean Droplet (Node) в Docker Compose**.
Пошаговая инструкция — в **[`DEPLOY_DROPLET.md`](DEPLOY_DROPLET.md)**:

- `git clone` проекта на droplet, `cp .env.example .env` и заполнить `BOT_TOKEN`/`TICKET_DOMAIN`
- `docker compose up -d --build` — поднимет `bot`, `cron` и `web` (Caddy/HTTPS)
- `node scripts/set-webhook.mjs https://<домен>/webhook`
- автодеплой при пуше в `main` через GitHub Actions (secrets: `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_PASSWORD`; путь `/opt/tickets-bot` захардкожен)

Локально для разработки:

```sh
npm install
BOT_TOKEN=<токен> node scripts/set-webhook.mjs --help  # не нужно локально
node migrate.js   # создать таблицы
BOT_TOKEN=<токен> node server.js
```

### 3. Настроить Mini App

1. Включите **GitHub Pages** в репозитории (Settings → Pages → Source: **GitHub Actions**).
2. Убедитесь, что `MINIAPP_URL` в `lib/config.js` указывает на ваш Pages-URL
   (`https://<username>.github.io/tickets-telegram-bot/`).
3. В **@BotFather** → ваш бот → **Menu Button** укажите ссылку на этот URL.

### Выбор городов события в мини-приложении

Чтобы при «Найти и следить» событие предлагало выбрать город, добавьте к `MINIAPP_URL`
в `lib/config.js` параметр `&api=https://ВАШ-ДОМЕН` (публичный `TICKET_DOMAIN` с droplet,
где бот слушает `/api/event-cities`). Без него событие добавляется без города.

## GitHub Actions

| Workflow | Триггер | Что делает |
|----------|---------|-----------|
| `deploy.yml` | push в `main` + `workflow_dispatch` | SSH на droplet → `git pull` + `docker compose up -d --build`. |
| `pages.yml` | push в `main` (изменения `miniapp/**`) | Публикует Mini App в GitHub Pages. |

Крон-проверка билетов выполняется **внутри docker-сервиса `cron`** (каждые
`CHECK_INTERVAL_MIN` минут), а не через GitHub Actions.

## Команды бота

- `/start` — приветствие и главное меню (кнопка «Найти и следить»).
- `/list` — список отслеживаемого (с кнопками удаления).
- `/check` — проверить источники прямо сейчас.
- `/help` — справка.

Мини-приложение позволяет искать события/площадки, добавлять их в список и
отслеживать ключевые слова; данные передаются боту через `WebApp.sendData`.

## Локальный тест

Smoke-тест проверяет слой `db` (SQLite DSL) на реальной базе:

```sh
npm test   # = npm run smoke → node smoke.mjs
```
