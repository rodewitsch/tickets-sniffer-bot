// Пробная DO Function: ТОЛЬКО замер egress-IP и доступности билетных сайтов.
// Ничего не пишет в БД, ключей не требует. Вопрос, на который отвечает:
// будет ли у Functions ДРУГОЙ исходящий IP, чем у Droplet 209.38.249.69?
// С этого IP bycard.by / 24afisha.by блокируют TCP:443 (замер 2026-11-28).
//
// ПРОВЕРЕННЫЕ ГРАБЛИ (контрольная функция hello/index в этом же namespace их
// подтвердила — она возвращает {"body":"Hello world!"}):
//   • `main: '...'` в project.yml ЛОМАЕТ загрузку: «The function did not
//     initialize properly» + «Cannot read properties of undefined (reading
//     'js')». Без `main` рантайм берёт index.js сам.
//   • имя функции в project.yml обязано совпадать с именем файла (index.js →
//     functions.name: index), иначе «Action is named in the config but does
//     not exist in the project».
//   • форма модуля — CommonJS: `function main(args)` + `exports.main = main`,
//     как в официальном sample-functions-nodejs-helloworld.
//
// Как читать ответ:
//   echo.ip            — egress-IP функции
//   echo.sameAsDroplet — совпал ли он с IP Droplet
//   targets.*.tcpMs    — время TCP-коннекта на 443 (null = не подключились)
//   targets.*.status   — HTTP-код, если коннект прошёл
//
// Если targets["bycard.by"].status === 200 — egress Functions годится как
// «парсер-прокси». Если tcpMs === null при живом abws — пул тот же.

const https = require('https');
const net = require('net');

// IP нашего Droplet — с него сайты недоступны (замерено 2026-11-28).
const DROPLET_IP = '209.38.249.69';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Свой egress-IP узнаём у независимого сервиса (не у DigitalOcean).
function fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA }, timeout: timeoutMs || 8000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: null, body: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: null, body: '', error: e.code || e.message }));
  });
}

// TCP-коннект на 443 БЕЗ TLS: показывает именно сетевую доступность.
// Именно тут блокируется Droplet — TLS не успевает начаться.
function tcpProbe(host, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port: 443, timeout: timeoutMs || 6000 });
    const done = (result) => { sock.destroy(); resolve(result); };
    sock.on('connect', () => done({ tcpMs: Date.now() - started }));
    sock.on('timeout', () => done({ tcpMs: null, error: 'timeout' }));
    sock.on('error', (e) => done({ tcpMs: null, error: e.code || e.message }));
  });
}

async function main() {
  const started = Date.now();

  // 1) Свой egress-IP двумя независимыми сервисами (сверяем, чтобы не поверить одному).
  const ipA = await fetchText('https://api.ipify.org?format=json');
  const ipB = await fetchText('https://ifconfig.co/json');
  let ip = null;
  try { ip = JSON.parse(ipA.body).ip; } catch (e) { /* попробуем второй */ }
  let ipAlt = null;
  try { ipAlt = JSON.parse(ipB.body).ip; } catch (e) { /* ок, одного хватит */ }

  // 2) Доступность сайтов, которые режут Droplet.
  const hosts = [
    'abws.bycard.by',   // API — работает и с Droplet (контроль)
    'bycard.by',        // сайт — с Droplet TCP-блок
    '24afisha.by',      // сайт — с Droplet TCP-блок
    'api.24afisha.by',  // API — с Droplet TCP-блок
    'ticketpro.by',     // работает с Droplet (контроль)
  ];
  const targets = {};
  for (const host of hosts) {
    const tcp = await tcpProbe(host);
    const item = { tcpMs: tcp.tcpMs, error: tcp.error || null, status: null };
    if (tcp.tcpMs !== null) {
      const page = await fetchText(`https://${host}/`, 8000);
      item.status = page.status;
    }
    targets[host] = item;
  }

  const result = {
    ok: true,
    ranAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    echo: {
      ip: ip || ipAlt,
      ipSecondary: ipAlt,
      sameAsDroplet: (ip || ipAlt) === DROPLET_IP,
      dropletIp: DROPLET_IP,
    },
    targets,
  };
  console.log('EGRESS_PROBE', JSON.stringify(result));
  return { body: result };
}

exports.main = main;
