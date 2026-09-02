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
| `lib/` | Business logic: `checker`, `watch`, `menus`, `webapp`, `util`, `http`, `jsonld`, `normalize`, `sources/{afisha,ticketpro}`, `config`. |
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
- **Afisha `events.uid` — city-aware**: `'<slug>@<city>'` (образует `afishaUidForCity`).
  Одно событие кэшируется отдельно по городам.
- **Сервер**: есть служебный эндпоинт `GET /api/event-cities?url=…` (CORS) для выбора
  городов события в мини-приложении; хост URL валидируется (SSRF-защита).
- Schema lives in `schema.js` (Drizzle `sqliteTable`). After editing schema run `npm run db:generate` (`drizzle-kit generate`), then `npm run migrate` to apply. `server.js` also applies migrations at startup.
- `SERVE_STATIC` is off in Docker; `miniapp/` is published to GitHub Pages.
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

## History

Previously the project targeted Telegram Serverless (`tgcloud`), which required a
custom module resolver (`loader/`) and a local `sdk` re-implementing the platform's
bare-import surface. Since Serverless isn't available, all of that abstraction was
removed. The bot now runs as ordinary Node with relative imports. Keep it that way —
do not reintroduce `sdk`/`loader`/bare imports.
