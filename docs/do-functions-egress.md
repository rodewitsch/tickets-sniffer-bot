# Вынос парсинга в DigitalOcean Functions: замер egress (2026-11-28)

Короткий отчёт об эксперименте. Вопрос был один: **даст ли DO Functions другой
исходящий IP, чем у Droplet**, — потому что `bycard.by` / `24afisha.by` /
`api.24afisha.by` блокируют IP сервера на TCP-уровне.

## Контекст проблемы

Droplet `209.38.249.69` (DigitalOcean, fra1):

- `abws.bycard.by` → OK, 34 мс
- `bycard.by`, `24afisha.by`, `api.24afisha.by` → **TCP:443 таймаут**
  (DNS резолвится: все три → `178.172.160.176`, но коннект не проходит)
- Локальная машина разработчика (A1, `178.172.146.25`) → все хосты OK
- Google egress (`translate.goog`) → страница отдаётся, 200

То есть блокировка идёт **по IP**, а не по стране и не по ASN.

До этой проверки проверка наличия билетов у 5 событий «афиши» + 1 ключевика
всегда возвращала `onSale=false` (см. коммит `8b8051a`: обход через
`abws.bycard.by` / `api/v3/pages/events/<slug>`, 59–352 мс). Эксперимент
отвечает, можно ли дополнительно читать HTML-страницы (JSON-LD).

## Установка (Windows)

```powershell
# doctl: в npm его нет, только бинарник с GitHub Releases
$v = (Invoke-RestMethod https://api.github.com/repos/digitalocean/doctl/releases/latest).tag_name
Invoke-WebRequest "https://github.com/digitalocean/doctl/releases/download/$v/doctl-$($v.TrimStart('v'))-windows-amd64.zip" -OutFile "$env:TEMP\doctl.zip"
Expand-Archive "$env:TEMP\doctl.zip" -DestinationPath .

.\doctl.exe auth init          # токен вводится в терминале, НЕ в чате
.\doctl.exe serverless install
.\doctl.exe serverless connect "<namespace-label>"
```

**Грабля:** `serverless install` падает на Windows с
`symlink ... A required privilege is not held by the client` — нужен
«Режим разработчика» (Параметры → Система → Для разработчиков).

**Токен:** `doctl account get` / `apps list` дают 403 при токене без этих scopes.
Для Functions этого достаточно (`serverless namespaces list` работает).

## Namespace

Функции живут в **отдельном** namespace, чтобы не смешиваться со статистикой
других проектов:

| | |
|---|---|
| Label | `Tickets Bot Parser` |
| ID | `fn-1f346050-edc3-4cc5-8f78-f0c2b59d4bb1` |
| Region | `fra1` |
| API host | `https://faas-fra1-afec6ce7.doserverless.co` |

> Раньше функции лежали в namespace `PET Projects Statistics`
> (`fn-297df797-…`). При переезде версии функций обнулились (0.0.1), URL
> изменились — env-переменные бота надо обновить.
>
> **Старый namespace НЕ очищен сознательно**: там же живут рабочие функции
> статистики других проектов (`npm_statistics`, `zepp_statistics`,
> `chrome_web_store_statistics`), а наши копии могут пригодиться как резерв.
> Если понадобится убрать — `doctl serverless connect "PET Projects Statistics"`
> и удалить функции по одной (`hello/index`, `netprobe/index`, `netproxy/index`,
> `parser/afisha`, `parser/bezkassira`, `parser/ticketpro`). Действие
> необратимо, поэтому по умолчанию не делалось.

Переключение:

```bash
doctl serverless connect "Tickets Bot Parser"
```

## Результат (namespace fra1, функция `netprobe/index`)

| Хост | Droplet | DO Functions (старый ns) | DO Functions (новый ns) |
|---|---|---|---|
| `abws.bycard.by` | OK, 34 мс | 200, 143 мс | **200**, 39 мс |
| `bycard.by` | TCP-таймаут | 200, 183 мс | **200**, 31 мс |
| `24afisha.by` | TCP-таймаут | 302, 105 мс | **302**, 75 мс |
| `api.24afisha.by` | TCP-таймаут | 200, 97 мс | **200**, 30 мс |
| `ticketpro.by` | OK | 200, 73 мс | **200**, 30 мс |

Egress-IP:
- старый namespace — `207.154.197.204`
- новый namespace — **`134.122.83.46`**

Оба не совпадают с Droplet и не заблокированы; новый заметно быстрее
(30–75 мс против 97–183). Полный прогон: **1 835 мс**.

## Стоимость

Тарификация — GiB-секунды: 256 МБ × ~2 с = 0.5 GiB-с на вызов.
При 95 циклах/сутки и 1 вызове на цикл ≈ **1 400 GiB-с/мес** против бесплатных
**90 000 GiB-с/мес** (≈1.6%). В текущем профиле нагрузки функции фактически
бесплатны.

Ограничения namespace: 120 одновременных вызовов, 600 вызовов/мин,
таймаут 15 мин, память 128 МБ–1 ГБ, **постоянного диска нет** (Volumes не
подключаются).

## ГРАБЛИ рантайма (проверены на контрольной функции)

Контрольная функция `hello/index` (официальный `sample-functions-nodejs-helloworld`)
сначала тоже падала — это и позволило отделить код от рантайма. Итог:

1. **`main: '<file>'` в `project.yml` ломает загрузку**:
   `The function did not initialize properly` +
   `TypeError: Cannot read properties of undefined (reading 'js')`.
   Строку `main` надо просто убрать — рантайм берёт `index.js` сам.
2. **Имя функции обязано совпадать с именем файла**: `index.js` →
   `functions.name: index`, иначе
   `Action is named in the config but does not exist in the project`.
3. **Форма модуля — CommonJS**: `function main(args) { … }` + `exports.main = main`.
   `export async function main` и глобальный `fetch` тоже падали.
4. **`package.json` рядом с функцией нельзя**: `runtime type could not be determined`.
5. **`exec.kind` фиксируется при создании** и НЕ меняется правкой `project.yml`
   (у старой функции остался `nodejs:22` после смены на `nodejs:default`) —
   нужна новая функция или удаление.
6. `nodejs:20` в этом namespace невалиден; работают `nodejs:22` и `nodejs:24`.

## Что это значит для проекта

- Вынос `lib/sources/afisha.js` в функцию **имеет смысл**: он снимает IP-блок
  и открывает HTML-страницы (JSON-LD), если они когда-нибудь понадобятся.
- **Но текущая проблема уже закрыта** без лямбд: `abws.bycard.by` доступен
  и с Droplet, и отдаёт и поиск, и расписание (см. `8b8051a`).
- Блокеры для полноценного выноса: кэш поиска (`SEARCH_CACHE_TTL_MS`),
  ротация окна (`rotationCursors`) и бюджеты цикла (`quotaMap`, `chatWallets`)
  живут **в памяти процесса** — их надо переносить в БД или оставлять на Droplet.
- Scheduled triggers в DigitalOcean Functions — **private preview** (макс. 3
  триггера), поэтому запуск всё равно идёт с Droplet по HTTP.

## Воспроизвести

```bash
cd experiments/do-functions-egress
doctl serverless deploy .
doctl serverless functions invoke netprobe/index
```

---

# Интеграция: функция-прокси `netproxy/index`

Сделана по итогам замера. Бот умеет ходить через неё, но по умолчанию **выключен**
(см. «Как включить»).

## Как устроено

1. `lib/http.js` получает `FETCH_PROXY_URL`. Если он задан и хост запроса входит
   в список `PROXY_HOSTS = ['bycard.by', '24afisha.by']`, запрос уходит в функцию:
   `GET <FETCH_PROXY_URL>?url=<encoded url>`.
2. Функция проверяет белый список **у себя** (не доверяет вызывающему), делает
   `fetch` от своего имени и возвращает `{ status, finalUrl, tookMs, body }`.
3. `lib/http.js` **разворачивает** этот JSON-конверт (обязательно: иначе вызывающий
   код получит JSON вместо HTML, и `extractJsonLd` найдёт 0 блоков).
4. Остальные хосты (`abws.bycard.by`, `ticketpro.by`, `bezkassira.by`) идут
   напрямую — лишний хоп добавляет задержку и точку отказа.

Функция также повторяет антибот-обход `hg-security` (тот же, что в `lib/http.js`):
без него сайт отдавал 200 и 1.2 КБ заглушки «Verification».

## Проверено

| Проверка | Результат |
|---|---|
| `httpGet` через прокси | 200, 175 813 байт, 833 мс |
| `fetchAfishaEventDetails` через прокси | «Цветы для Элджернона» · `onSale=true` · 3 декабря 2026, 379 мс |
| Прямой путь (`abws`, без прокси) | 200, не затронут |
| `npm test` | PASS |

## Как включить

На Droplet добавить в `.env` (и в `docker-compose.yml`, иначе не подхватится):

```
FETCH_PROXY_URL=https://faas-fra1-<hash>.doserverless.co/api/v1/web/<ns>/netproxy/index
```

URL берётся командой:

```bash
doctl serverless functions get netproxy/index --url
```

Затем `docker compose up -d`.

## Безопасность

- `netproxy` — **открытый GET-прокси** по белому списку из двух доменов.
  Ставить `webSecure` (заголовок `X-Require-Whisk-Auth`) и передавать значение
  через `FETCH_PROXY_SECRET`.
- Белый список проверяется и в боте (`safeFetchUrl`), и в функции.
- Только `https`, редиректы ограничены теми же хостами.

## Что осталось (не сделано намеренно)

---

# Парсеры в Functions (схема «парсеры — функции, состояние — Droplet»)

Сделано: `searchAfisha`/`searchTicketpro`/`searchBezkassira` и их `details/venue/
availability` выполняются в DO Functions. БД, кэш, бюджеты, Telegram и cron
остаются на Droplet — там им и место (SQLite, память процесса).

## Функции

| Функция | Actions |
|---|---|
| `parser/afisha` | `search`, `details`, `availability`, `venue` |
| `parser/ticketpro` | `search`, `details`, `venueLinks`, `venues` |
| `parser/bezkassira` | `search`, `details`, `organizer` |

Контракт: `GET ?action=<name>&<params>` → `{ ok, result }` или `{ ok:false, error }`.

## Как включается

`lib/sources/remote.js` — единственное место, где решается «локально или удалённо».
Включается переменными окружения (пустое значение = источник парсится локально):

```
PARSER_URL_AFISHA=https://faas-fra1-…/parser/afisha
PARSER_URL_TICKETPRO=https://faas-fra1-…/parser/ticketpro
PARSER_URL_BEZKASSIRA=https://faas-fra1-…/parser/bezkassira
```

URL берутся так:
```bash
doctl serverless functions get parser/afisha --url
```

Актуальные URL (namespace `fn-1f346050-…`):

```
PARSER_URL_AFISHA=https://faas-fra1-afec6ce7.doserverless.co/api/v1/web/fn-1f346050-edc3-4cc5-8f78-f0c2b59d4bb1/parser/afisha
PARSER_URL_TICKETPRO=https://faas-fra1-afec6ce7.doserverless.co/api/v1/web/fn-1f346050-edc3-4cc5-8f78-f0c2b59d4bb1/parser/ticketpro
PARSER_URL_BEZKASSIRA=https://faas-fra1-afec6ce7.doserverless.co/api/v1/web/fn-1f346050-edc3-4cc5-8f78-f0c2b59d4bb1/parser/bezkassira
FETCH_PROXY_URL=https://faas-fra1-afec6ce7.doserverless.co/api/v1/web/fn-1f346050-edc3-4cc5-8f78-f0c2b59d4bb1/netproxy/index
```

`lib/checker.js` содержит тонкие обёртки (`searchAfisha`, `fetchTicketproEventDetails`,
…), которые зовут `parserOrLocal(...)`. Если env не задан — вызов идёт в локальный
модуль, как раньше. **Нулевой риск при выключенном env**: проверено `npm test`.

## Код не дублируется

`lib/build.cmd` / `lib/build.sh` копируют нужные модули из корневого `lib/` в пакет
функции на этапе сборки. Правило DO Functions: `.include` не принимает `..`,
поэтому папка `lib/` кладётся ВНУТРЬ пакета (`packages/parser/<name>/lib/`), а
`env.js` — рядом с ней, т.к. `config.js` делает `../env.js`.

## Проверено (2026-11-28, fra1)

| Проверка | Результат |
|---|---|
| `parser/afisha` → search «театр» | ok, 5 событий + 5 площадок |
| `parser/afisha` → details | «Цветы для Элджернона», `onSale=true` |
| `parser/afisha` → availability | ok, `onSale=false` (все сеансы «Продано») |
| `parser/ticketpro` → search «концерт» | ok, 36 |
| `parser/bezkassira` → search «концерт» | ok, 20 |
| Маршрутизация через `parserOrLocal` | afisha 1 641 мс, ticketpro 1 729 мс |
| Локальный режим (env пуст) | `npm test` PASS |

## ГРАБЛИ, найденные при выносе

1. **ESM-модули проекта нельзя `require`** в точке входа (она CommonJS):
   `ERR_REQUIRE_ESM`. Поэтому парсеры подключаются через `import()` — он работает
   и из CJS, а `main` сделан `async`.
2. **`.include` не принимает `..`** к отдельным файлам — только папку `../../../lib/`.
   Отсюда копирование модулей внутрь пакета на сборке.
3. **`config.js` импортирует `../env.js`** — при копировании `env.js` внутрь `lib/`
   путь ломается. Кладём `env.js` уровнем выше `lib/`.
4. **`build.cmd` вызывается без аргументов** при `doctl serverless deploy` —
   скрипт должен сам обойти все пакеты `parser/*`, иначе сборка падает.

## Что осталось

- **Кэш и ротация не перенесены**: `SEARCH_CACHE_TTL_MS`, `rotationCursors`,
  `quotaMap`, `chatWallets` живут в памяти процесса Droplet. Пока они там,
  цикл нельзя параллелить между лямбдами — и не нужно: 13 с при окне 300–600 с.
- **БД остаётся на Droplet**: DO Functions не поддерживает Volumes, а
  `better-sqlite3` не умеет сетевые подключения. Полный перенос = Managed
  Postgres + переписывание Drizzle-слоя; не делалось и сейчас не оправдано.
- **Автозапуск по расписанию**: scheduled triggers в DO Functions — private
  preview (3 триггера макс.), поэтому запуск идёт с Droplet по HTTP.
