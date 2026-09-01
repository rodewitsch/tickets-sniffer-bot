# Работа с сервером (Droplet) — гайд

Краткая шпаргалка: как смотреть данные БД, проверять контейнеры и логи.

- Сервер (Droplet): `root@209.38.249.69`
- Проект на сервере: `/opt/tickets-bot`
- Docker Compose: `bot` (вебхук), `cron` (проверки), `web` (Caddy/HTTPS)

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
