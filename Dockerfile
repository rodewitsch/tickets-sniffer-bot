# Лёгкий образ бота для DigitalOcean Droplet (docker-compose).
# Сервисы: bot (вебхук) и cron (проверка) используют один образ.

# ---- стадия сборки: ставим better-sqlite3 (нативный модуль) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# build-essential: нужны для сборки better-sqlite3
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && apk del python3 make g++

# ---- финальный образ без build-инструментов ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# tzdata: чтобы TZ=Europe/Minsk (docker-compose) влиял на new Date().getHours()
# и другие «локальные» методы даты (Alpine не ставит tzdata по умолчанию).
RUN apk add --no-cache tzdata

# node_modules из build-стадии
COPY --from=build /app/node_modules ./node_modules

# приложение (плоская структура, относительные импорты)
COPY package.json package-lock.json ./
COPY schema.js ./schema.js
COPY db.js ./db.js
COPY api.js ./api.js
COPY env.js ./env.js
COPY lib ./lib
COPY handlers ./handlers
COPY server.js ./server.js
COPY migrate.js ./migrate.js
COPY check.js ./check.js
COPY cron.js ./cron.js
COPY scripts ./scripts
# миграции drizzle (SQL + journal), читаются migrate.js при старте
COPY drizzle ./drizzle

# директория для SQLite (подставляется volume в compose)
RUN mkdir -p /data && chmod 777 /data

EXPOSE 8080

# Сервис bot:      node server.js
# Сервис cron:     node cron.js
CMD ["node", "server.js"]
