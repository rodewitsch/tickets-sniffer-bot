// Сторожевой таймер опроса билетов.
//
// Зачем: 10–11 ноября циклы не запускались СУТКИ (`runCheck` падал на первом же
// обращении к `deliverable`), а узнать об этом можно было только из суточного
// отчёта в 09:00 — и даже там это выглядело просто как нули, без объяснения.
// Владелец должен получить сообщение САМ, в момент поломки, а не после.
//
// Здесь ДВА независимых сторожа, потому что у них разные слепые зоны:
//
//   1. Внутрипроцессный (этот модуль, вызывается из cron.js после каждого цикла).
//      Ловит: цикл упал с исключением, цикл не запускается по таймеру (таймер
//      не сработал), процесс жив, но стоит. НЕ ловит: процесс упал целиком
//      или висит насмерть.
//   2. Внешний — `GET /health` в server.js (другой контейнер). Он смотрит на
//      meta.lastCheckAt в базе, поэтому видит и «cron умер целиком»: его
//      проверяет Docker healthcheck И любой внешний монитор (UptimeRobot и т.п.),
//      у которого есть HTTP-эндпоинт для алерта.
//      Намеренно НЕ порог по старым циклам: пока цикл длится (бывало 280 с),
//      таймер следующего ещё не сработал, и «мёртвый» статус был бы ложным.
//      Порог = пауза по расписанию + запас, и только он.
//
// Контракт: никакие сбои сторожа не ломают цикл проверки, не бросают исключений
// в cron и не шлют шторм — не чаще ALERT_REPEAT_MS по одной и той же причине.

import db from '../db.js';
import { api } from '../api.js';
import { meta } from '../schema.js';
import { eq } from '../db.js';
import { STATS_CHAT_ID } from './config.js';

// Состояние одного сторожа. Ключи в meta — с префиксом, чтобы не мешать другим.
const STATE_KEY = 'watchdogState';

export const DEFAULT_STALE_MIN = 90;   // порог по умолчанию для внешнего /health
const ALERT_REPEAT_MS = 60 * 60 * 1000; // не чаще 1 раза в час на одну причину

function alertChatId() {
  return STATS_CHAT_ID ? String(STATS_CHAT_ID) : '';
}

function ageMinutes(tsSec, now = Date.now()) {
  if (!tsSec) return null;
  return Math.max(0, Math.round((now - Number(tsSec) * 1000) / 60000));
}

function minskHm(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Minsk',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => p.find((x) => x.type === t)?.value || '00';
  return `${get('hour')}:${get('minute')}`;
}

export async function getMeta(key) {
  const row = await db.select().from(meta).where(eq(meta.key, key)).get();
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

// Возраст последнего цикла по meta.lastCheckAt (ключ пишет runCheck).
// null — цикл не запускался ни разу (свежая база, не повод для алерта).
export async function cycleStatus(now = Date.now()) {
  const raw = Number(await getMeta('lastCheckAt')) || 0;
  if (!raw) return { at: null, ageMinutes: null };
  return { at: raw, ageMinutes: ageMinutes(raw, now) };
}

/**
 * Состояние опроса для /health.
 *
 * `status`:
 *   • ok    — цикл был недавно;
 *   • stale — последний цикл старше порога (опрос встал);
 *   • none  — циклов ещё не было (свежая установка), это НЕ ошибка.
 *
 * `ok:false` возвращается только для stale: Docker healthcheck маппит любой
 * нефиктивный ответ в 503, и падать из-за пустой базы при первом запуске нельзя.
 */
export async function healthStatus({ staleMin = DEFAULT_STALE_MIN, now = Date.now() } = {}) {
  const st = await cycleStatus(now);
  const limit = Number(staleMin) > 0 ? Number(staleMin) : DEFAULT_STALE_MIN;
  if (st.at === null) {
    return { ok: true, status: 'none', lastCheckAt: null, ageMinutes: null, staleAfterMin: limit };
  }
  const stale = st.ageMinutes > limit;
  return {
    ok: !stale,
    status: stale ? 'stale' : 'ok',
    lastCheckAt: new Date(st.at * 1000).toISOString(),
    ageMinutes: st.ageMinutes,
    staleAfterMin: limit,
  };
}

async function loadState() {
  try {
    const raw = await getMeta(STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveState(state) {
  try {
    await setMeta(STATE_KEY, JSON.stringify(state));
  } catch {
    // Состояние — удобство (дедуп алертов), а не данные. Сбой записи не важен.
  }
}

/**
 * Сообщение владельцу о поломке опроса.
 * Ошибка отправки тоже не бросается наружу: сторож сообщает о проблеме,
 * но сам проблемой становиться не должен.
 */
async function sendAlert(text) {
  const chatId = alertChatId();
  if (!chatId) {
    console.warn('[watchdog] STATS_CHAT_ID не задан — алерт не отправлен');
    return false;
  }
  try {
    await api.sendMessage({ chat_id: chatId, text });
    return true;
  } catch (err) {
    console.warn('[watchdog] алерт не отправлен:', err && err.message || err);
    return false;
  }
}

/**
 * Сторож, который вызывает cron.js после каждой попытки цикла.
 *
 *   opts.lastError  — текст ошибки, если цикл упал с исключением (иначе null)
 *   opts.staleMin   — порог «цикл не запускается» в минутах (пауза + запас)
 *   opts.delayMin   — пауза до следующего цикла по расписанию (для текста)
 *   opts.nextInMs   — когда таймер обещал позвонить (для «не сработал»)
 *
 * Возвращает { alerted } — для лога; исключений не бросает.
 */
export async function watchdogTick({ lastError = null, staleMin = DEFAULT_STALE_MIN, delayMin = null, nextInMs = null } = {}) {
  try {
    const state = await loadState();
    const now = Date.now();
    const st = await cycleStatus(now);

    // Причина алерта: сбой последнего цикла > «цикл не запускается».
    // Сбой цикла конкретнее (мы знаем текст), поэтому он и выигрывает.
    let reason = null;
    if (lastError) {
      reason = 'cycle_failed';
    } else if (st.ageMinutes !== null && st.ageMinutes > (Number(staleMin) || DEFAULT_STALE_MIN)) {
      reason = 'no_cycles';
    }

    if (!reason) {
      // Всё в порядке: снимаем прошлый алерт, чтобы следующая поломка сообщилась
      // сразу, а не ждала час.
      if (state.active) {
        await saveState({ active: null, lastSentAt: state.lastSentAt || 0 });
      }
      return { alerted: false };
    }

    // Дедуп: одна и та же причина — не чаще раза в час. Другая причина — сразу.
    const sameCause = state.active === reason;
    if (sameCause && now - (Number(state.lastSentAt) || 0) < ALERT_REPEAT_MS) {
      return { alerted: false };
    }

    const lines = ['🚨 <b>Опрос билетов не работает</b>'];
    if (reason === 'cycle_failed') {
      // Текст ошибки — внутренние данные (имена переменных, пути), но чат
      // владельца не публичный, а без причины разбираться невозможно.
      lines.push(`• Последний цикл упал с ошибкой: <code>${String(lastError).slice(0, 300)}</code>`);
    }
    if (st.ageMinutes !== null) {
      const h = Math.floor(st.ageMinutes / 60);
      const m = st.ageMinutes % 60;
      const ageText = h ? `${h} ч ${m} мин` : `${m} мин`;
      lines.push(`• Последний успешный цикл: ${minskHm(st.at * 1000)} МСК (${ageText} назад)`);
    } else {
      lines.push('• Циклов ещё не было — опрос ни разу не запускался');
    }
    if (delayMin) {
      lines.push(`• Расписание: следующий цикл через ~${delayMin} мин${nextInMs ? ` (таймер сработал на ${Math.round(nextInMs / 60000)} мин позже)` : ''}`);
    }
    lines.push('');
    lines.push('Что проверить: <code>docker logs tickets-bot-cron --since 1h</code> — в логе каждые несколько минут должна быть строка <code>[cron] … check:</code>. Если ошибок нет, а циклов нет — виноват таймер или зависший процесс, а не сайты.');
    if (reason === 'cycle_failed') {
      lines.push('');
      lines.push('Пока сбой сохраняется, следующее напоминание — через час.');
    } else {
      lines.push('');
      lines.push('Повторные напоминания — раз в час, пока циклы не вернутся.');
    }

    const sent = await sendAlert(lines.join('\n'));
    if (sent) {
      await saveState({ active: reason, lastSentAt: now });
    }
    return { alerted: sent };
  } catch (err) {
    console.warn('[watchdog] проверка не удалась:', err && err.message || err);
    return { alerted: false };
  }
}
