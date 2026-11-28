// Замер: сколько стоит один вызов функции-парсера с Droplet (round-trip).
const urls = {
  afisha: process.env.PARSER_URL_AFISHA,
  ticketpro: process.env.PARSER_URL_TICKETPRO,
};

for (const [name, base] of Object.entries(urls)) {
  if (!base) { console.log(name, 'not set'); continue; }
  const times = [];
  for (let i = 0; i < 3; i++) {
    const q = new URLSearchParams({ action: 'search', query: 'театр' });
    const t = Date.now();
    try {
      const r = await fetch(`${base}?${q}`, { signal: AbortSignal.timeout(30000) });
      await r.text();
      times.push(`${Date.now() - t}ms/${r.status}`);
    } catch (e) {
      times.push(`${Date.now() - t}ms/${e.name}`);
    }
  }
  console.log(`${name}: ${times.join(' | ')}`);
}
