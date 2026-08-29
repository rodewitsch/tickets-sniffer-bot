// Probe script: checks whether the anti-bot challenges on 24afisha.by / bycard.by
// can be passed with a plain HTTP client (cookie extraction), and discovers
// ticketpro.by internal API endpoints.
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url, headers = {}, redirect = 'follow') {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru,en;q=0.8',
      ...headers,
    },
    redirect,
  });
  const text = await res.text().catch(() => '');
  return {
    status: res.status,
    finalUrl: res.url,
    size: text.length,
    text,
    headers: Object.fromEntries(res.headers),
  };
}

const isChallenge = (html) => html.length < 5000 && /Verification|hg-security/.test(html);
const extractToken = (html) => {
  const m = html.match(/hg-security=([A-Za-z0-9_\-=.]+)/);
  return m ? m[1] : null;
};

async function probeProtected(name, baseUrl, pageUrl) {
  console.log(`\n=== ${name} ===`);
  try {
    const r1 = await get(baseUrl);
    console.log(`step1 ${baseUrl} -> ${r1.status} size=${r1.size} challenge=${isChallenge(r1.text)}`);
    const setCookie = r1.headers['set-cookie'];
    if (setCookie) console.log('set-cookie:', setCookie.slice(0, 200));
    const token = extractToken(r1.text);
    if (!token) {
      console.log('NO TOKEN FOUND');
      return;
    }
    console.log('token:', token.slice(0, 40) + '...');
    const cookie = `hg-security=${token}`;
    const r2 = await get(pageUrl, { Cookie: cookie, Referer: baseUrl });
    console.log(`step2 ${pageUrl} -> ${r2.status} size=${r2.size} challenge=${isChallenge(r2.text)}`);
    if (!isChallenge(r2.text) && r2.size > 5000) {
      fs.writeFileSync(`research/${name}_page.html`, r2.text);
      console.log(`saved -> research/${name}_page.html`);
      const hosts = [
        ...new Set(
          (r2.text.match(/https?:\/\/[a-z0-9.\-]+\.(?:24afisha|bycard)\.by/gi) || []),
        ),
      ];
      console.log('subdomains:', hosts.join(', '));
      const apiHints = [
        ...new Set((r2.text.match(/["'`]\/?api\/[a-z0-9_\-\/.]+["'`]/gi) || [])),
      ].slice(0, 30);
      console.log('api hints:', apiHints.join(', ') || 'none');
    } else {
      fs.writeFileSync(`research/${name}_step2.html`, r2.text);
      console.log('still challenge or tiny page, saved for inspection');
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

async function probeTicketpro() {
  console.log('\n=== ticketpro ===');
  try {
    const cat = await get('https://www.ticketpro.by/bilety-na-koncert/');
    console.log(`category page -> ${cat.status} size=${cat.size} challenge=${isChallenge(cat.text)}`);
    fs.writeFileSync('research/ticketpro_concerts.html', cat.text);
    const apiHints = [
      ...new Set(cat.text.match(/["'`][^"'`]*api[^"'`]*["'`]/gi) || []),
    ]
      .filter((s) => s.length < 120)
      .slice(0, 40);
    console.log('api-like strings:', apiHints.join('\n  ') || 'none');
    const scripts = [...cat.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    console.log('scripts:', scripts.join('\n  '));
    // widget api guesses
    const guesses = [
      'https://widget.ticketpro.by/api/v1/events',
      'https://widget.ticketpro.by/api/events',
      'https://www.ticketpro.by/api/events',
      'https://www.ticketpro.by/search/?q=macan',
    ];
    for (const u of guesses) {
      try {
        const r = await get(u, {}, 'manual');
        const ct = r.headers['content-type'] || '';
        console.log(`guess ${u} -> ${r.status} ${ct} size=${r.size} loc=${r.headers.location || ''}`);
        if (ct.includes('json')) {
          fs.writeFileSync('research/tp_guess.json', r.text);
          console.log('  JSON sample:', r.text.slice(0, 300));
        }
      } catch (e) {
        console.log(`guess ${u} ERROR ${e.message}`);
      }
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

await probeProtected(
  'afisha',
  'https://24afisha.by/ru/minsk',
  'https://24afisha.by/ru/minsk/events/concert',
);
await probeProtected('bycard', 'https://bycard.by/', 'https://bycard.by/afisha/minsk/concert');
await probeTicketpro();
console.log('\nDONE');
