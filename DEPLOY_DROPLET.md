# Деплой на DigitalOcean Droplet (Docker Compose + Caddy)

Поднимает всё одной командой на свежем droplet: **`docker compose up -d --build`**.
На сервере нужны только **Docker + Docker Compose**. HTTPS обеспечивает **Caddy**
(автоматический Let's Encrypt, без настройки Nginx/certbot вручную).

## Что ставим

- **Droplet** 1 vCPU / 512MB (~$6/мес). Достаточно с запасом.
- **Docker + Compose**.
- **Mini App** — на GitHub Pages (см. README), сервер не нужен.

## Состав (docker compose)

| Сервис | Что делает |
|---|---|
| `bot` | Node-вебхук (`server.js`), создаёт таблицы при старте. Внутри сети на `8080`. |
| `cron` | Периодическая проверка билетов (`cron.js`) по случайному расписанию: днём (9:00–21:00) 15–30 мин, ночью — 60–120 мин. |
| `web` | Caddy: автоматический HTTPS (Let's Encrypt) + reverse proxy на `bot:8080`. |

Общий **volume** `tickets-data` — SQLite БД на диске, общая для `bot` и `cron`.

## Быстрый старт (вручную)

### 1. Создать Droplet и поставить Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # перелогиньтесь
docker --version && docker compose version
```

### 2. Клонировать проект и настроить .env

```bash
sudo mkdir -p /opt/tickets-bot && sudo chown -R $USER:$USER /opt/tickets-bot
git clone <ваш-репозиторий> /opt/tickets-bot
cd /opt/tickets-bot
cp .env.example .env
nano .env
# --- заполните:
#   BOT_TOKEN=<токен бота от @BotFather>
#   TICKET_DOMAIN=<ваш домен, напр. bot.example.com>  (A-запись → IP droplet)
```

### 3. Поднять

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f bot
```

Caddy автоматически выпустит и продлит сертификат для `TICKET_DOMAIN` (нужны
открытые порты 80/443 снаружи).

### 4. Подключить вебхук Telegram

```bash
cd /opt/tickets-bot
export $(grep -v '^#' .env | xargs)  # подгрузить переменные
node scripts/set-webhook.mjs "https://${TICKET_DOMAIN}/webhook"
```

Откройте бота и отправьте `/start` — должен ответить.

## Автодеплой (GitHub Actions)

При пуше в `main` workflow
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):
1. собирает Docker-образ проекта,
2. `docker save` → tar,
3. копирует tar на droplet (scp),
4. `docker load` + `docker compose up -d`.

Git на сервере не нужен — сервер остаётся чистым (только `docker-compose.yml`,
`Caddyfile`, `.env`). Путь `/opt/tickets-bot` захардкожен в workflow.

Настроить один раз в GitHub (Settings → Secrets and variables → Actions):

| Secret | Значение |
|---|---|
| `DROPLET_HOST` | IP или домен droplet (`209.38.249.69`) |
| `DROPLET_USER` | пользователь SSH (обычно `root`) |
| `DROPLET_PASSWORD` | пароль SSH для пользователя |

> Пароль передаётся через `sshpass`. Избегайте спецсимволов в пароле, которые
> ломают кавычки в shell (пробелы, `$`, `"` и т.п.), либо заэкранируйте их.

## Проверка / состояние

```bash
docker compose ps
curl https://<домен>/health                 # {"ok":true}
docker compose logs -f cron                 # циклы проверки каждые 15 мин
docker compose exec bot sh -c 'ls -la /data'
```

## Бэкап БД

Volume `tickets-data` (файл `/data/bot.db`):

```bash
docker compose run --rm bot sh -c 'cp /data/bot.db /data/bot-$(date +%F).db'
# или копировать том /data во внешнее хранилище (DO Spaces) по расписанию
```

## Известные ограничения

- SQLite на одном volume — один процесс записи; для личного бота достаточно.
- Caddy отдаёт наружу 80/443; `bot` не публичен — только через Caddy.
- `server.js` в `SERVE_STATIC` не копирует `miniapp/` (Mini App на GitHub Pages).
