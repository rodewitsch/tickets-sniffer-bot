# Работа с сервером (Droplet) — гайд

Краткая шпаргалка: как смотреть данные БД, проверять контейнеры и логи.

- Сервер (Droplet): `root@209.38.249.69`
- Проект на сервере: `/opt/tickets-bot`
- Docker Compose: `bot` (вебхук), `cron` (проверки), `web` (Caddy/HTTPS)

> Хотите разобрать **структуру кода**, запустить проект **локально** для разработки
> или понять технические детали (например, как устроен выбор города)? — см. раздел
> [Для разработчиков](#для-разработчиков) внизу.

---

## 1. Контейнеры

### Посмотреть статус
```bash
ssh root@209.38.249.69
cd /opt/tickets-bot
docker compose ps
```
Полезно зайти одной командой:
```bash
ssh -o ConnectTimeout=20 root@209.38.249.69 "cd /opt/tickets-bot && docker compose ps"
```
`Up ... (healthy)` — работает как надо. `(healthy)` появляется у `bot`, т.к. у него есть healthcheck.

Три сервиса:
| Сервис | Контейнер | Что делает |
|--------|-----------|------------|
| `bot`  | `tickets-bot` | Вебхук Telegram (`server.js`), создаёт/пишет БД |
| `cron` | `tickets-bot-cron` | Цикл проверки билетов |
| `web`  | `tickets-bot-web` | Caddy, HTTPS + прокси |

### Логи
Все контейнеры:
```bash
cd /opt/tickets-bot && docker compose logs
```
Только один сервис, последние N строк, следить за новыми:
```bash
docker compose logs -f --tail=100 bot
docker compose logs -f --tail=100 cron
docker compose logs -f --tail=100 web
```
Посмотреть логи по времени:
```bash
docker compose logs --since 10m bot
```
Логи хранятся в `/var/lib/docker/containers/<id>/*-json.log` (обычно не нужно трогать напрямую — `docker compose logs` их читает).

### Перезапуск
```bash
cd /opt/tickets-bot && docker compose restart bot
# после изменения кода — полная пересборка:
docker compose up -d --build
```

---

## 2. Где лежит БД

- **В контейнере:** `/data/bot.db`
- **На хосте (физически):** `/var/lib/docker/volumes/tickets-bot_tickets-data/_data/bot.db`
- Это named volume `tickets-bot_tickets-data`, общий для `bot` и `cron` → данные живут между рестартами.

Рядом могут быть WAL-файлы: `bot.db-shm`, `bot.db-wal`. Если `bot.db` маленький, а `-wal` большой — основная масса данных в WAL (это нормально). Не копируй только `bot.db`, копируй все три, либо делай снапшот через sqlite `.backup` (см. ниже).

---

## 3. Посмотреть данные из БД

### Вариант А — внутри контейнера (рекомендовано)
В образе может не быть `sqlite3`. Проверяем и смотрим:
```bash
ssh root@209.38.249.69
docker exec -it tickets-bot sh
# внутри контейнера:
which sqlite3        # если есть — используем
sqlite3 /data/bot.db ".tables"
sqlite3 /data/bot.db "SELECT * FROM users;"
exit
```

Если `sqlite3` нет — вариант через Node (он точно есть):
```bash
docker exec -it tickets-bot node -e '
const Database = require("better-sqlite3");
const db = new Database("/data/bot.db", { readonly: true });
console.log("tables:", db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\"").all());
console.log("users:", db.prepare("SELECT * FROM users").all());
console.log("watchItems:", db.prepare("SELECT * FROM watchItems").all());
db.close();
'
```

### Вариант Б — через один готовый рецепт по SSH (из любой машины)
```bash
ssh root@209.38.249.69 "docker exec tickets-bot node -e 'const D=require(\"better-sqlite3\");const db=new D(\"/data/bot.db\",{readonly:true});const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type=\\\"table\\\"\").all();console.log(t);for(const x of t){const n=x.name;console.log(\"--- \"+n);console.log(db.prepare(\"SELECT * FROM \"+n).all())}'"
```

### Таблицы (по `schema.js`)
| Таблица | Содержимое |
|---------|-----------|
| `users` | Telegram-пользователи |
| `watchItems` | Отслеживаемые ключевые слова/события/площадки |
| `events` | Найденные события/билеты |
| `notifications` | История уведомлений |
| `meta` | Служебные значения |

---

## 4. Резервная копия БД

### Правильный способ (снапшот через sqlite, без остановки)
```bash
ssh root@209.38.249.69
docker exec tickets-bot sh -c 'sqlite3 /data/bot.db ".backup /tmp/bot-snapshot.db"' # если есть sqlite3
# иначе через node:
docker exec tickets-bot node -e 'const D=require("better-sqlite3");const d=new D("/data/bot.db");d.backup("/tmp/bot-snapshot.db").then(()=>{console.log("backup ok")});'
# затем вытащить наружу:
docker cp tickets-bot:/tmp/bot-snapshot.db /opt/tickets-bot/
```

### Простой способ (с остановкой контейнеров)
```bash
cd /opt/tickets-bot && docker compose stop bot cron
cp -a /var/lib/docker/volumes/tickets-bot_tickets-data/_data /opt/tickets-bot/db-backup
docker compose start
```
Копируешь `_data` целиком (все 3 файла: `bot.db`, `-shm`, `-wal`).

---

## 5. Полезное

- Проверить здоровье бота:
  ```bash
  ssh root@209.38.249.69 "curl -s http://127.0.0.1:8080/health"
  ```
- Обновить код и перезадеплоить:
  ```bash
  cd /opt/tickets-bot && docker compose up -d --build
  ```
- Диск/свободное место:
  ```bash
  df -h
  ```

---

## 6. Рассылки (аннонсы версий)

Периодически нужно сообщить пользователям о новой версии бота. Для этого есть
одноразовый скрипт `scripts/send-release.mjs` и папка `messages/` с текстами.

### Принцип

- **Текст сообщения — отдельный файл**, а не код: на каждый релиз кладётся свой
  `messages/<версия>.txt`. Так рассылка переиспользуется, не требуя правки скрипта.
- **Скрипт в двух режимах:**
  - `preview` — отправить текст только **владельцу** (`STATS_CHAT_ID`), чтобы проверить, как выглядит сообщение;
  - `broadcast` — разослать **всем пользователям** из таблицы `users` (последовательно, ~20 сообщений/сек,
    чаты, заблокировавшие бота, пропускаются с логом, не роняя рассылку).
- Сообщение шлётся с `parse_mode: 'HTML'`, поэтому в файле можно использовать
  `<b>`, `<i>`, эмодзи и переносы строк.

### Текст файла

Файл `messages/<версия>.txt` — просто текст сообщения. Например `messages/0.2.0.txt`.
Никакой разметки-обёртки не нужно; пустые строки дают абзацы.

### Запуск

**Локально (проверка синтаксиса текста, без реальной отправки — нет токена):**
```bash
node scripts/send-release.mjs preview messages/0.2.0.txt   # → ошибка BOT_TOKEN, если токен не задан
```

**На сервере (реальная отправка).** Скрипт и текст не входят в Docker-образ, поэтому
закидываем их в работающий контейнер и запускаем (`BOT_TOKEN` и `DB_PATH` уже в
окружении контейнера):
```bash
# локально: задеплоить скрипт и текст в контейнер
scp scripts/send-release.mjs messages/0.2.0.txt root@209.38.249.69:/tmp/

# на сервере
ssh root@209.38.249.69
cd /opt/tickets-bot
docker cp /tmp/send-release.mjs  tickets-bot:/app/scripts/send-release.mjs
docker cp /tmp/0.2.0.txt         tickets-bot:/app/messages/0.2.0.txt

# 1) предпросмотр владельцу -> посмотреть в Telegram, поправить текст при необходимости
docker compose exec -T bot node scripts/send-release.mjs preview messages/0.2.0.txt

# 2) после одобрения — рассылка всем
docker compose exec -T bot node scripts/send-release.mjs broadcast messages/0.2.0.txt
```

Ожидаемый вывод broadcast:
```
[broadcast] 3 users
[broadcast] done: 3 sent, 0 failed
```

> ⚠️ Файлы, закинутые `docker cp`, исчезают при пересборке Docker-образа
> (`docker compose up -d --build`). На каждый новый релиз повторите шаги заливки
> скрипта и свежего текста. Если захотите, чтобы рассылка жила в образе всегда,
> пропишите `COPY scripts/ messages/ /app/` в `Dockerfile`.

---

## Для разработчиков

Всё техническое, что нужно тем, кто хочет понять код или запустить проект локально.

### Структура проекта

| Путь | Назначение |
|------|-----------|
| `schema.js` | Схема БД (Drizzle `sqliteTable`). |
| `db.js` | Слой SQLite: `drizzle(better-sqlite3)` + ре-экспорт операторов. |
| `drizzle/` | Миграции (генерирует `drizzle-kit`, применяет `migrate`). |
| `api.js` | Telegram Bot API (`api.<method>` → unwrapped, `BotApiError`). |
| `env.js` | Конфиг из `process.env` (`BOT_TOKEN`, `PORT`, `DB_PATH`, …). |
| `handlers/` | Вебхук-хендлеры (`message`, `callback_query`), вызываются из `server.js`. |
| `lib/` | Бизнес-логика: `checker`, `watch`, `menus`, `webapp`, `util`, `http`, `jsonld`, `normalize`, `config`, `sources/{afisha,ticketpro,bezkassira}`. |
| `server.js` | HTTP-сервер вебхука (`/webhook`, `/check`, `/health`). |
| `cron.js` | Демон проверки билетов (docker-сервис `cron`). |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Контейнеры + HTTPS. |
| `miniapp/` | Статика Telegram Mini App (публикуется на GitHub Pages). |
| `scripts/` | Служебные утилиты: `set-webhook.mjs`, `send-release.mjs` (рассылки). |
| `messages/` | Тексты рассылок по версиям, напр. `0.2.0.txt` (см. раздел «Рассылки»). |
| `.github/workflows/` | Автодеплой на droplet (`deploy.yml`) + публикация Mini App (`pages.yml`). |

Источники билетов (`lib/config.js`): `afisha` (24afisha.by / bycard.by),
`ticketpro` (Ticketpro.by) и `bezkassira` (BezKassira.by).

### Локальная разработка (вне Docker)

```sh
npm install
node migrate.js                # создать таблицы (применить миграции)
BOT_TOKEN=<токен> node server.js   # локальный запуск вебхука
```

Для локальной разработки не нужен публичный вебхук — можно гонять `check.js`
(разовый цикл проверки) или `cron.js` напрямую.

### Тесты

Smoke-тест проверяет слой `db` (SQLite DSL) на реальной базе:

```sh
npm test   # = npm run smoke → node smoke.mjs
```

### Мини-приложение

- Статика в `miniapp/`, публикуется workflow `pages.yml` на GitHub Pages
  (сервер её не отдаёт — `SERVE_STATIC` выключен в Docker).
- `MINIAPP_URL` в `lib/config.js` указывает на Pages-URL; параметр
  `&api=https://ВАШ-ДОМЕН` включает выбор городов события (`GET /api/event-cities`).
- Mini App передаёт данные боту через `WebApp.sendData` (payload вида
  `{ a: 'add'|'del', k, s, q, u, c }`).

### Наличие билетов по городу (технически)

События 24afisha.by / bycard.by живут по одному URL на город
(`/ru/<город>/event/<slug>`), и расписание/наличие билетов различается между
городами. Семантика `watch_items.city`:

- `city` NULL — город не выбран (по умолчанию город события из его URL).
- `city` = `brest` — следить только за Брестом.
- `city` = `all` — следить во всех городах (уведомить, если билеты появятся хоть где-то).

Наличие по выбранному городу берётся из schedule API «Афиши», а не из JSON-LD:
`GET api.24afisha.by/api/v2/schedule/events/<числовой-id события>?cityId=<N>` →
`data[0].objects[].sessions[].isSaleOpen`. Список городов — `GET /api/v2/cities`
(slug → id). Кино размечено в JSON-LD как `Movie` (без offers/location), поэтому
для него JSON-LD бесполезен — работает только schedule API.

Afisha `events.uid` — city-aware: `'<slug>@<city>'` (см. `afishaUidForCity`).
Одно и то же событие кэшируется отдельно по городам.
