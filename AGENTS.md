# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
Auto-loaded by Claude Code, Cursor, and similar tools — keep it short and true.

## What this project is

A **Telegram Mini App bot** that watches ticket sites (**24afisha.by**,
**bycard.by** — one backend — and **ticketpro.by**) and notifies a user when
tickets for a tracked keyword/event/venue go on sale, with preview and a buy link.

It's a plain **Node.js** app (hosted on a DigitalOcean Droplet). A small HTTP
server (`server.js`) receives Telegram webhooks, routes updates to `handlers/*`,
and stores data in **SQLite** via `better-sqlite3`. Everything runs in Docker
Compose (`bot`, `cron`, `web`/Caddy).

## Layout

| Path | What it is |
|------|-----------|
| `schema.js` | DB tables as named exports (`users`, `watchItems`, `events`, `notifications`, `meta`), defined with Drizzle `sqliteTable`. |
| `db.js` | SQLite layer: `drizzle(better-sqlite3)` handle + re-exported operators (`eq/and/desc/sql`). |
| `drizzle/` | Generated migration SQL + journal (from `drizzle-kit generate`), applied at startup. |
| `api.js` | Telegram Bot API: `api.<method>(params)` → unwrapped result, throws `BotApiError`. |
| `env.js` | Config from `process.env`: `BOT_TOKEN`, `PORT`, `DB_PATH`, `CHECK_SECRET`, `API_HOST`. |
| `lib/` | Business logic: `checker`, `watch`, `menus`, `webapp`, `util`, `http`, `jsonld`, `normalize`, `stats`, `ai-report`, `delivery`, `sources/{afisha,ticketpro,bezkassira}`, `config`. |
| `handlers/` | Webhook handlers, one per update type (`message`, `callback_query`). |
| `server.js` | HTTP server: `POST /webhook`, `GET /check`, `GET /health`. Entrypoint. |
| `migrate.js` | Applies `drizzle/` migrations. Runs at server startup and via `npm run migrate`. |
| `check.js` | One-shot check cycle (CLI). |
| `cron.js` | Loop that runs the check on a randomized schedule: 15–30 min during 9:00–21:00, 60–120 min at night (docker `cron` service, TZ=Europe/Minsk). |
| `scripts/set-webhook.mjs` | Sets the Telegram webhook URL. |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Containerization + HTTPS reverse proxy. |
| `miniapp/` | Static Telegram Mini App (hosted on GitHub Pages, not served by the bot). |

## Rules that bite

- **Relative imports only** (no bare `sdk`/`schema`/`lib` specifiers — that was the
  old Telegram Serverless style, removed). Each module imports its neighbours with
  `./`/`../` and a `.js` extension.
  - ✅ `import db from '../db.js'` / `import { users } from '../schema.js'`
- **All `db` calls are async** (Drizzle `db`). `db.select()...all()/get()`, `db.insert()...returning()`, `db.update()...run()`, `db.delete()...run()`.
- `db.js` exports `db` (default) and the operators `eq/and/desc/sql` (named). Import operators from there or from `drizzle-orm`.
- `api` lives in `api.js` (separate from `db.js`). Import it from wherever you need
  to call Telegram.
- **No foreign keys** in SQLite — enforce integrity in app code.
- **Город у позиций слежения**: `watch_items.city` = slug (`brest`), `'all'` (все города)
  или NULL (город из URL события). События 24afisha живут по одному URL на город
  (`/ru/<город>/event/<slug>`), расписание/наличие в городах может различаться.
- **Наличие по городу (afisha)** берётся из schedule API, а не из JSON-LD:
  `GET api.24afisha.by/api/v2/schedule/events/<числовой-id события>?cityId=<N>` →
  `data[0].objects[].sessions[].isSaleOpen`. Список городов: `GET /api/v2/cities` (slug→id).
  Кино размечено JSON-LD как `Movie` (без offers/location) — JSON-LD там бесполезен.
- **Площадки (afisha)**: старые страницы площадок `/ru/<city>/events/<slug>` «битые»
  (title «Билеты в undefined», событий нет) — не скрапить. Рабочая публичная страница —
  `/ru/object/<slug>`; её данные: `GET /api/v3/pages/objects/<slug>?cityId=0&lang=ru&slug=true&jsonld=0`
  → `object` (id/name/slug/cityId) + `more[]` (мероприятия театра/концертов с
  `sessions[].isSaleOpen`). Киносеансы лежат отдельно: `GET /api/v2/schedule/objects/<числовой-id>`
  → `data[0].events[]` (тоже `sessions[].isSaleOpen`). Чекер объединяет оба источника
  (у кино `more[]` пуст, у театра `events[]` пуст). Ссылка площадки — `/ru/object/<slug>`.
  См. `fetchAfishaVenue(Events)` / `afishaVenueListingUrl` в `lib/sources/afisha.js`.
  Одноимённые площадки различаются городом (он зашит в slug/id), а не выбором города вручную.
- **Битые страницы событий (afisha)**: часть страниц `/ru/<city>/event/<slug>` на 24afisha.by
  падает в SSR — HTTP 500, «Server error» (напр. `idioty-2`; причина в серверном рендере
  отзывов: `TypeError: Cannot read property '200x200' of undefined`). Через клиентскую
  навигацию (поиск на сайте) та же страница открывается. Лечится подменой на bycard.by
  (общий бэкенд, страница всегда открывается): `afishaWorkingEventUrl(url)` в
  `lib/sources/afisha.js` (проверка кэшируется) — применяется при добавлении события
  (`lib/webapp.js`), в уведомлениях (`notifyIfDue` в `lib/checker.js`) и в позиции
  (`checkEventItem`). В мини-приложении «Открыть» у событий ведёт на bycard.by.
- **Afisha `events.uid` — city-aware**: `'<slug>@<city>'` (образует `afishaUidForCity`).
  Одно событие кэшируется отдельно по городам.
- **Сервер**: есть служебный эндпоинт `GET /api/event-cities?url=…` (CORS) для выбора
  городов события в мини-приложении; хост URL валидируется (SSRF-защита).
- Schema lives in `schema.js` (Drizzle `sqliteTable`). After editing schema run `npm run db:generate` (`drizzle-kit generate`), then `npm run migrate` to apply. `server.js` also applies migrations at startup.
- **Площадки из поиска — через очередь `venue_queue`**, а не «обходом на месте».
  Ключевики только ставят площадки в очередь (`enqueueVenue`), обход делает
  `runVenueCrawl()` в `runCheck` ПОСЛЕ цикла позиций (иначе свежие кандидаты ждали бы
  следующий цикл). `dueAt` — срок следующего обхода по срочности событий
  (`venueIntervalMs`), `cursor` — продолжение длинной сетки. Один URL обходится ОДИН
  раз за проход, уведомления уходят всем позициям, чей поиск его нашёл.
  Не зажимай `dueAt` в `Math.max(now, …)` — ломает приоритет очереди.
  Старый `venueQueryCache` (Map в памяти) удалён: он давал 1296 «пропусков» на 85 обходов.
- **Площадку опознаём по числовому id, а не по slug.** Сайт переименовывает slug'и
  (`332-zasluzhennyj-kollektiv-…` → `332-belorusskij-…-bolshoj-zal`), а `id` в начале
  slug'а неизменен. `resolveAfishaVenueUrl` сначала ищет тот же `id`, и только потом —
  по названию. Если поиск по полному названию пуст (зал в названии сайта зовётся иначе:
  «(Малая сцена)» vs «(Малый зал)»), повторяем без уточнения в скобках: по названию
  театра находятся все залы, и нужный опознаётся по `id`. Одинаковый счёт у залов
  ОДНОГО театра (`id` совпадает) — не «неоднозначность», ссылку чиним.
- **Заблокировавший бота чат — это НЕ ошибка, а повод удалить его данные.**
  Telegram отвечает 403 «Forbidden: bot was blocked by the user» на каждую отправку.
  Раньше это роняло позицию и поднимало `errorItems`: в проде два таких чата давали
  216 «ошибок» в сутки (все 356 `item.failed` за 3 дня — это 403), и в отчёте горел 🔴.
  Сначала это заменили пометкой `users.blocked_at` (позиции не проверяются), но пометка
  не решала главного: 405 позиций трёх чатов оставались в базе и каждый цикл писали
  «пропущено из-за блокировки», жили в `staleItems` и выглядели мёртвыми подписками.
  Поэтому `markChatBlocked()` в `lib/delivery.js` теперь вызывает `deleteAllUserData()`.
  Подписки того, кто заблокировал бота, ему не нужны, а в метриках — только шум.
  Если он вернётся и напишет боту, `handlers/message.js` заведёт его заново
  (`insert ... onConflictDoUpdate`) и снимет `blockedAt`, если он там остался.
- **`resultsTruncated` разбит по источникам.** `MAX_RESULTS_PER_QUERY` (10) обрезает
  выдачу поиска, но цена разная: у «афиши» найденные площадки уходят в `venue_queue`
  с `dueAt` и обходятся позже (`notifyFromAfishaVenues`), а у ticketpro/bezkassira
  добора нет — хвост теряется по-настоящему. В отчёте ⚠️ — только для потерь;
  обрезание «афиши» — ℹ️. Не путай суммарный `resultsTruncated` (старые строки
  `check_log`) с разрезанными колонками.
- **«� Больше не уведомлять» глушит СОБЫТИЕ, а не подписку.** Под словом «театр»
  лежат десятки спектаклей, поэтому кнопка под карточкой пишет строку в
  `muted_events` (ключ — `dedupeKey`, та же единица, что у антидубля:
  `ev:<название>:<день>`), а `watch_items` не трогает. `notifyIfDue` проверяет
  `isMuted()` до запроса страницы события. Заглушка действует на чат целиком, а
  не на позицию: событие не придёт, даже если его нашла другая подписка того же
  чата. Обратный путь — экран «🔕 Заглушённые события» (`muted:list` / `muted:un:<id>`
  / `muted:clear`), иначе заглушённое не вернуть. Старый формат `mute:<id>` из уже
  отправленных сообщений остаётся рабочим (деактивация позиции) — не ломать его.
- **«🚪 Отключить бота» — удаление, а не отписка.** Живёт в разделе «Помощь»
  (`helpKeyboard()`, кнопка `account:disable`), а НЕ отдельной reply-кнопкой под
  полем ввода: редкое необратимое действие не должно попадаться под палец.
  `deleteAllUserData()` в
  `lib/watch.js` стирает `venue_queue` (строки чата И строки его позиций — иначе
  остаются «сироты», которые обходят вечно), `watch_items`, `notifications`,
  `muted_events` и `users`. `events` НЕ трогаем: это общий справочник по сайтам,
  а не данные пользователя. Удаление необратимо, поэтому в чате всегда две
  ступени: кнопка (`account:disable`) → подтверждение с числом позиций →
  `account:disable:yes`. `:no` возвращает обычный экран и НИЧЕГО не удаляет. После
  удаления шлём `remove_keyboard: true`, чтобы кнопки не остались у того, кто
  просил стереть данные. Текст кнопки живёт в константе `DISABLE_BUTTON` и
  используется в inline-кнопке справки и как подпись `/stop`; reply-кнопкой его
  больше не шлём (старые сообщения с ней Telegram обрабатывает как текст —
  `handlers/message.js` по-прежнему узнаёт нажатие по тексту).

- **Сервер (Droplet) — диск всего 8.7 ГБ и он ЗАБИВАЛСЯ до 100%** (`/var/lib/containerd`
  копит старые образы после деплоя; симптом — `docker cp`/`scp`: `no space left on device`,
  в логах `gc failed`). При работе на сервере сначала `df -h /`, при нехватке —
  `docker image prune -a -f && docker builder prune -a -f`.
- `SERVE_STATIC` is off in Docker; `miniapp/` is published to GitHub Pages.
- **`CHECK_SECRET` обязателен**: при пустом значении `GET /check` отвечает 503
  (`check_disabled`), а не открывает полный цикл проверки всем желающим.
- **`GET /health` — не только «процесс жив», но и «опрос идёт»**.
  `lib/watchdog.js` `healthStatus()` читает `meta.lastCheckAt`: `status: ok|stale|none`,
  `ageMinutes`, `staleAfterMin` (env `STALE_CHECK_MIN`, дефолт 90 мин — самая
  длинная пауза 60 мин плюс запас). Порог — только «старый `lastCheckAt`», а НЕ
  «нет нового цикла»: пока цикл идёт (бывало 280 с), следующий таймер ещё не
  сработал, и красный статус был бы ложным. `none` (циклов ещё не было) — `ok:true`,
  иначе Docker healthcheck уронил бы приложение на пустой базе.
  `stale` → HTTP **503**, это и есть внешний алерт: Docker healthcheck и любой
  монитор (UptimeRobot и т.п.) увидят не только падение `bot`, но и смерть `cron`.
- **Внутренний сторож (`lib/watchdog.js`, вызывается из `cron.js` после каждой
  попытки цикла)**. Шлёт в `STATS_CHAT_ID` «🚨 Опрос билетов не работает», если
  `runCheck` бросил исключение или `lastCheckAt` старше `STALE_CHECK_MIN`.
  Дедуп: та же причина — не чаще раза в час (`meta.watchdogState`), выздоровление
  снимает метку, чтобы следующая поломка сообщилась сразу. Контракт: ни один сбой
  сторожа не бросает исключение в cron и не ломает цикл.
- **Commits**: always in **English** and following **Conventional Commits**
  (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`, etc.), e.g.
  `fix: refresh mini app watch list after delete`. Never write commit messages in
  Russian — project UI/docs are in Russian, but commit messages must be English.

## Run / deploy

- Dev: `npm install`, set `BOT_TOKEN`, `npm run migrate`, `npm start`.
- Prod (Droplet): `docker compose up -d --build` — bots start `bot` (webhook) and
  `cron` (check loop); `web` (Caddy) gives HTTPS. See `docs/DEPLOY_DROPLET.md` and
  `docs/SERVER_GUIDE.md` (also covers release broadcasts via `scripts/send-release.mjs` + `messages/`).
- Auto-deploy: GitHub Actions `.github/workflows/deploy.yml` → builds image → `docker save` → scp to
  droplet → `docker load` → `docker compose up -d` (no git on server). Secrets: `DROPLET_HOST`,
  `DROPLET_USER`, `DROPLET_PASSWORD`. Path to project is hardcoded (`/opt/tickets-bot`).
- Tests: `npm test` (= `npm run smoke`) validates the DB layer (Drizzle + SQLite) against a real DB.
  `npm run test:ai` covers the AI report (`scripts/test-ai-report.mjs`, no key needed).

## Daily AI report

`lib/ai-report.js` + `sendAiReport()` in `lib/stats.js` send a short human
analysis of the day's numbers right after the regular stats message.

- Model: DeepSeek (`deepseek-chat`), OpenAI-compatible API at `DEEPSEEK_API_BASE`.
- Context = `collectDiagnostics()` in `lib/stats.js`: today's counters, a 7-day
  trend from `check_log`, broken venues, stale watch items. **Never raw logs** —
  the snapshot is ~700 tokens; raw logs are megabytes.
- **Graceful degradation is a hard contract**: no `DEEPSEEK_API_KEY` ⇒ feature off;
  any HTTP/timeout/parse failure ⇒ `null`, never an exception into the stats path.
  The `lastStatsDay` marker is written *before* the AI step so a failure cannot
  trigger a duplicate base report.
- Answer is sent with `parse_mode: 'HTML'`, so model output must be escaped via
  `escapeHtml()` from `lib/util.js` — the model writes markdown/emoji freely.
- The request has its own `AbortSignal.timeout(AI_TIMEOUT_MS)`; a hung call
  blocked a check cycle once (`api.js` bug), don't repeat it.


## History

Previously the project targeted Telegram Serverless (`tgcloud`), which required a
custom module resolver (`loader/`) and a local `sdk` re-implementing the platform's
bare-import surface. Since Serverless isn't available, all of that abstraction was
removed. The bot now runs as ordinary Node with relative imports. Keep it that way —
do not reintroduce `sdk`/`loader`/bare imports.
