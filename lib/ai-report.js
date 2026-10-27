// Ежедневный AI-разбор статистики бота через DeepSeek.
//
// Идея: цифры в отчёте видит человек, но «что с этим делать» приходится держать
// в голове. Модель получает структурированный снимок (lib/stats.js →
// collectDiagnostics) и возвращает короткий человеческий разбор: что сломалось,
// что подозрительно, что стоит посмотреть.
//
// Контракты, которые НЕЛЬЗЯ ломать:
//   • нет ключа DEEPSEEK_API_KEY → функция выключена, бот работает как раньше;
//   • любая ошибка сети/API → возвращаем null, никогда не бросаем исключение
//     в путь отправки статистики;
//   • отвечаем простым текстом без разметки — вставлять чужой HTML в
//     parse_mode:'HTML' сообщение слишком рискованно (сломает всё сообщение).

import { DEEPSEEK_API_KEY, DEEPSEEK_API_BASE } from '../env.js';
import { AI_MODEL, AI_TIMEOUT_MS, AI_MAX_TOKENS } from './config.js';

/** Включён ли AI-разбор (задан ли ключ). */
export function aiReportEnabled() {
  return Boolean(DEEPSEEK_API_KEY);
}

// Системная инструкция. Пишем её по-русски: отчёт читает владелец бота, а
// смешение языков в промпте заставляет модель съезжать в английский.
const SYSTEM_PROMPT = `Ты — инженер по надёжности, который следит за телеграм-ботом отслеживания билетов.

Бот периодически обходит сайты (24afisha.by / bycard.by / ticketpro.by / bezkassira.by),
ищет новые события и проверяет наличие билетов. У него ограниченный бюджет обхода
на цикл, поэтому часть работы откладывается на следующий цикл — это нормально.

Что означают поля:
- venue — площадка, найденная поиском; обход идёт через очередь venueQueue.
  failing — площадка стабильно отдаёт ошибку (скорее всего, страница удалена или
  переименована). waiting — сколько площадок уже «просрочено» и ждёт обхода.
- budgetPct — какая доля бюджета обхода тратится в среднем за цикл. Стабильно
  >90% означает, что бот постоянно упирается в потолок и копит долг.
- medianMs / cycles на цикл: сравни с прошлыми днями, важна динамика, не абсолют.
- staleOnSale — события, которые уже прошли, но всё ещё помечены как «в продаже»
  (забыли снять флаг — это мусор в базе).
- neverChecked — события, добавленные в базу, но ни разу не проверенные.
- staleItems — позиции слежения, которые не проверялись больше суток.
- trend — по одному срезу на сутки, свежие сверху.

Формат ответа (строго):
- 6–10 строк, каждая — отдельная мысль с эмодзи в начале.
- Русский язык, разговорный и конкретный. Без воды, без вступлений вроде
  «Вот анализ данных». Без markdown-разметки, без обратных кавычек, без HTML.
- Сначала самое тревожное, потом норма, потом что посмотреть.
- Если всё в порядке — так и скажи одной-двумя строками, не выдумывай проблем.
- Не повторяй сырые цифры без вывода. «failed=0» — это не мысль,
  «за сутки ни одного сбоя, обход укладывается в бюджет» — мысль.
- Заканчивай одной конкретной рекомендацией, если она есть.`;

/**
 * Собирает текст запроса: снимок + компактная инструкция.
 * Экспортируется отдельно, чтобы тесты могли проверить состав промпта.
 */
export function buildPrompt(diagnostics) {
  return [
    'Снимок состояния бота за последние сутки и тренд за неделю (JSON):',
    '```json',
    JSON.stringify(diagnostics, null, 2),
    '```',
    'Дай разбор по правилам.',
  ].join('\n');
}

/**
 * Обрезает ответ до безопасного для Telegram размера.
 * Лимит сообщения — 4096 символов, но разбор должен быть коротким;
 * режем по последней целой строке, чтобы не рвать предложение.
 */
function clampAnswer(text, limit = 1500) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd() + '…';
}

/**
 * Запрашивает разбор у DeepSeek.
 *
 * @param {object} diagnostics — результат collectDiagnostics()
 * @returns {Promise<string|null>} текст разбора или null (выключено / ошибка)
 */
export async function requestAiReport(diagnostics) {
  if (!aiReportEnabled()) return null;
  if (!diagnostics || typeof diagnostics !== 'object') return null;

  const url = `${DEEPSEEK_API_BASE.replace(/\/+$/, '')}/chat/completions`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(diagnostics) },
        ],
        // Низкая температура: это разбор цифр, а не творчество.
        temperature: 0.3,
        max_tokens: AI_MAX_TOKENS,
        stream: false,
      }),
      // Свой таймаут обязателен: без него зависший запрос держит цикл,
      // ровно как это было с вызовами Telegram API.
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ai-report] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) {
      console.warn('[ai-report] пустой ответ модели');
      return null;
    }

    console.log(`[ai-report] готово, usage=${data?.usage?.total_tokens ?? '?'} токенов`);
    return clampAnswer(text);
  } catch (err) {
    // Сюда попадают таймаут, DNS, обрыв соединения и битый JSON.
    console.warn(`[ai-report] ошибка запроса: ${err?.message || err}`);
    return null;
  }
}
