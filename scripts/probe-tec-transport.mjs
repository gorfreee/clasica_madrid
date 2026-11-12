import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const output = 'ingestion/work/tec-transport/results';
await mkdir(output, { recursive: true });
const endpoints = [
  ['canal-api', 'https://www.teatroscanal.com/wp-json/tribe/events/v1/events?categories=musica&per_page=50&page=1&start_date=2026-11-12+00%3A00%3A00&end_date=2027-08-31+23%3A59%3A59&status=publish'],
  ['escorial-api', 'https://www.teatroauditorioescorial.es/wp-json/tribe/events/v1/events?categories=conciertos&per_page=50&page=1&start_date=2026-11-12+00%3A00%3A00&end_date=2027-08-31+23%3A59%3A59&status=publish'],
  ['canal-rest-route', 'https://www.teatroscanal.com/?rest_route=/tribe/events/v1/events&categories=musica'],
  ['escorial-rest-route', 'https://www.teatroauditorioescorial.es/?rest_route=/tribe/events/v1/events&categories=conciertos'],
  ['canal-ical', 'https://www.teatroscanal.com/calendario-cartelera-madrid/?ical=1'],
  ['canal-html', 'https://www.cdcm.madrid/teatroscanal/programacion/categoria/musica'],
  ['canal-html-page2', 'https://www.cdcm.madrid/teatroscanal/programacion/categoria/musica?page=1'],
  ['escorial-html', 'https://www.cdcm.madrid/auditorioescorial/programacion'],
  ['escorial-html-page2', 'https://www.cdcm.madrid/auditorioescorial/programacion?page=1'],
  ['canal-detail', 'https://www.cdcm.madrid/teatroscanal/espectaculo/xvii-festival-ensembles'],
  ['escorial-detail', 'https://www.cdcm.madrid/auditorioescorial/espectaculo/concierto-navidad-2026'],
  ['drupal-jsonapi', 'https://www.cdcm.madrid/jsonapi'],
];
const results = [];
// Sequential bounded public GETs; never log cookies, credentials or response headers wholesale.
for (const [name, url] of endpoints) {
  for (const transport of ['direct', 'relay']) {
    if (transport === 'relay' && !name.endsWith('-api')) continue;
    if (transport === 'relay' && (!process.env.INGEST_FETCH_RELAY_URL || !process.env.INGEST_FETCH_RELAY_TOKEN)) {
      results.push({ name, url, transport, error: 'relay not configured' }); continue;
    }
    const target = transport === 'direct' ? new URL(url) : new URL(process.env.INGEST_FETCH_RELAY_URL);
    if (transport === 'relay') target.searchParams.set('url', url);
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(30000), headers: {
        'user-agent': 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)',
        accept: name.endsWith('-api') || name.endsWith('-rest-route') ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(transport === 'relay' ? { authorization: `Bearer ${process.env.INGEST_FETCH_RELAY_TOKEN}` } : {}),
      } });
      const body = await response.text();
      await writeFile(`${output}/${name}-${transport}.txt`, body);
      let json;
      try { json = JSON.parse(body); } catch {}
      const row = { name, url, transport, status: response.status,
        ...(transport === 'direct' ? { finalUrl: response.url } : {}),
        contentType: response.headers.get('content-type'), bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1],
        events: Array.isArray(json?.events) ? json.events.length : undefined,
        total: json?.total, totalPages: json?.total_pages,
        cards: [...body.matchAll(/class="event-card__title-link"/g)].length,
      };
      results.push(row); console.log(JSON.stringify(row));
    } catch (error) {
      // Do not print the request URL/error of an authenticated relay request.
      const row = { name, url, transport, error: error.name }; results.push(row); console.log(JSON.stringify(row));
    }
  }
}
await writeFile(`${output}/responses.json`, JSON.stringify(results, null, 2));
