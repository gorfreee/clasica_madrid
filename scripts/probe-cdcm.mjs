import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = 'ingestion/work/cdcm-probe';
await mkdir(dir, { recursive: true });
const urls = [
  ['canal', 'https://www.cdcm.madrid/teatroscanal/programacion/categoria/musica'],
  ['escorial', 'https://www.cdcm.madrid/auditorioescorial/programacion'],
  ['ensembles', 'https://www.cdcm.madrid/teatroscanal/espectaculo/xvii-festival-ensembles'],
  ['navidad', 'https://www.cdcm.madrid/auditorioescorial/espectaculo/concierto-navidad-2026'],
];
const rows = [];
async function save(name, transport, url, status, body, contentType, finalUrl) {
  const row = { name, transport, url, status, contentType, finalUrl, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1], cards: [...body.matchAll(/class="event-card__title-link"/g)].length };
  rows.push(row); console.log(JSON.stringify(row));
  await writeFile(`${dir}/${name}-${transport}.html`, body);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
try {
  for (const [name, url] of urls) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    await save(name, 'node-default', url, r.status, await r.text(), r.headers.get('content-type'), r.url);
    const page = await ctx.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await save(name, 'chrome', url, response?.status(), await page.content(), response?.headers()['content-type'], page.url());
    } catch(e) { console.log(JSON.stringify({name,transport:'chrome',error:e.name})); }
    finally { await page.close(); }
    const curl = spawnSync('curl', ['--http2', '-L', '--max-time', '30', '-sS', '-w', '\n%{http_code} %{content_type} %{url_effective}', url], { encoding: 'utf8', maxBuffer: 3000000 });
    const cut = curl.stdout.lastIndexOf('\n');
    const meta = curl.stdout.slice(cut+1).split(' ');
    await save(name, 'curl-http2', url, Number(meta[0]), curl.stdout.slice(0,cut), meta[1], meta[2]);
  }
} finally { await browser.close(); }
await writeFile(`${dir}/responses.json`, JSON.stringify(rows,null,2));
