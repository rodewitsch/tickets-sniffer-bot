@echo off
REM Сборка библиотеки проекта Functions (Windows). См. build.sh — логика та же.
REM
REM Раскладка: собранные модули кладутся ВНУТРЬ пакета функции
REM (packages/parser/<name>/lib/), потому что .include не принимает `..`.
REM env.js кладётся на уровень ВЫШЕ lib/, т.к. lib/config.js делает
REM `import { ... } from '../env.js'` — при переносе в lib/env.js путь ломается.
setlocal
set HERE=%~dp0
REM lib\ → do-functions-egress → experiments → корень репозитория (три уровня)
set REPO_ROOT=%HERE%..\..\..\
set TARGET=%~1
REM deploy вызывает build.cmd БЕЗ аргументов. Тогда собираем во ВСЕ пакеты
REM parser/*, иначе сборка падает на «usage».
if "%TARGET%"=="" (
  for /d %%d in ("%HERE%..\packages\parser\*") do call "%~f0" "%%~fd"
  exit /b 0
)

if not exist "%TARGET%\lib\sources" mkdir "%TARGET%\lib\sources"

for %%f in (util.js cities.js jsonld.js normalize.js config.js http.js) do (
  copy /Y "%REPO_ROOT%lib\%%f" "%TARGET%\lib\%%f" >nul
)
REM env.js — рядом с lib/, а не внутри: так его ждёт ../env.js из config.js
copy /Y "%REPO_ROOT%env.js" "%TARGET%\env.js" >nul

for %%f in (common.js afisha.js ticketpro.js bezkassira.js) do (
  copy /Y "%REPO_ROOT%lib\sources\%%f" "%TARGET%\lib\sources\%%f" >nul
)

echo [lib-build] parsers copied to %TARGET%
endlocal
