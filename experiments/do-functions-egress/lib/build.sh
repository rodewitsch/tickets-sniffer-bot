# Сборка библиотеки проекта Functions.
#
# Зачем: правила DO Functions разрешают в .include только пути вида
# `../../../lib/...`, а модули парсинга лежат в корне репозитория (вне пакета).
# Копировать их руками в репозиторий нельзя — появились бы две версии правды.
# Поэтому копируем ИХ ЗДЕСЬ, на этапе сборки: в git лежат только этот скрипт и
# пустая папка lib/, а содержимое появляется при deploy.
#
# Копируется ровно то, что нужно парсерам. checker/db/schema/stats НЕ тянутся:
# у них нет смысла в функции, и они тянут better-sqlite3.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
# lib/ → do-functions-egress → experiments → корень репозитория (три уровня)
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

mkdir -p "$HERE/sources"

for f in util.js cities.js jsonld.js normalize.js config.js http.js; do
  cp "$REPO_ROOT/lib/$f" "$HERE/$f"
done

cp "$REPO_ROOT/env.js" "$HERE/env.js"

for f in common.js afisha.js ticketpro.js bezkassira.js; do
  cp "$REPO_ROOT/lib/sources/$f" "$HERE/sources/$f"
done

echo "[lib-build] parsers copied from $REPO_ROOT"
