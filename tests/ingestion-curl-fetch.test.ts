import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCdcmWithCurl } from '../src/ingestion/curl-fetch.ts';
import { getText, resetOriginCookieJar, takeRecordedHttpAttempts } from '../src/ingestion/http.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { startObservability } from '../src/ingestion/observability.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
const url = 'https://www.cdcm.madrid/auditorioescorial/programacion';
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); resetOriginCookieJar(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fakeCurl(meta: Record<string, unknown>, body = '<html>real document</html>', exit = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cdcm-curl-')); dirs.push(dir);
  const output = body + '\n' + JSON.stringify({ http_code: 200, content_type: 'text/html; charset=utf-8', url_effective: url, ...meta });
  await writeFile(path.join(dir, 'curl'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))},JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exit});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
  return dir;
}
describe('cliente HTTP curl limitado al portal público CDCM', () => {
  it('usa GET, sin shell, cookies, credenciales, UA falso ni seguimiento de redirecciones', async () => {
    const dir = await fakeCurl({}); await expect(getCdcmWithCurl(url, 1000)).resolves.toContain('real document');
    const args = JSON.parse(await readFile(path.join(dir, 'args.json'), 'utf8'));
    expect(args).toContain('--max-time'); expect(args).toContain('--max-filesize'); expect(args.slice(-2)).toEqual(['--url', url]);
    for(const flag of ['-L', '--location', '-A', '--user-agent', '--cookie', '--header', '--data']) expect(args).not.toContain(flag);
  });
  for(const status of [202, 204, 301, 403, 429, 503]) it(`HTTP ${status} nunca se interpreta como agenda`, async () => {
    await fakeCurl({ http_code: status }); await expect(getCdcmWithCurl(url, 1000)).rejects.toMatchObject({ status });
  });
  it('rechaza JSON, redirecciones implícitas, cuerpos vacíos y bloqueos con status 200', async () => {
    for(const [meta, body] of [[{ content_type: 'application/json' }, '{}'], [{ url_effective: 'https://evil.test/' }, '<html>'], [{}, ''], [{}, '<title>ERROR: The request could not be satisfied</title>']] as const) { await fakeCurl(meta, body); await expect(getCdcmWithCurl(url, 1000)).rejects.toThrow(); }
  });
  it('no consulta hosts de origin, sedes cruzadas ni URLs ajenas', async () => {
    for(const target of ['https://origin202603-cdcm.cdcm.madrid/auditorioescorial/programacion', 'https://evil.test/auditorioescorial/programacion', 'https://www.cdcm.madrid@evil.test/auditorioescorial/programacion', 'http://www.cdcm.madrid/auditorioescorial/programacion', 'https://www.cdcm.madrid/jsonapi']) await expect(getCdcmWithCurl(target, 1000)).rejects.toThrow(/permitida/);
  });
  it('se integra en getText como HTTP directo y conserva status y duración', async () => {
    await fakeCurl({}); await getText(url, 1000); expect(takeRecordedHttpAttempts()).toEqual([expect.objectContaining({ url, transport: 'direct', status: 200, durationMs: expect.any(Number) })]);
    await fakeCurl({ http_code: 403 }); await expect(getText(url, 1000)).rejects.toMatchObject({ status: 403 }); expect(takeRecordedHttpAttempts()[0]).toMatchObject({ url, transport: 'direct', status: 403 });
  });
  it('un fallo de curl permanece visible sin convertirlo en vacío', async () => { await fakeCurl({}, '', 28); await expect(getCdcmWithCurl(url, 1000)).rejects.toThrow(/tiempo agotado/); });
  it('la recuperación real getText → curl contabiliza el 502 y el reintento correcto', async () => {
    const dir = await fakeCurl({});
    const root = path.join(import.meta.dirname, 'fixtures/ingestion/cdcm');
    const listing = await readFile(path.join(root, 'escorial-list.html'), 'utf8');
    const detail = await readFile(path.join(root, 'navidad.html'), 'utf8');
    const state = path.join(dir, 'attempt.txt');
    await writeFile(path.join(dir, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const url = process.argv.at(-1);
let status = 200;
if (url.includes('/espectaculo/')) {
  const attempt = fs.existsSync(${JSON.stringify(state)}) ? 2 : 1;
  fs.writeFileSync(${JSON.stringify(state)}, String(attempt));
  if (attempt === 1) status = 502;
}
process.stdout.write((url.endsWith('/programacion') ? ${JSON.stringify(listing)} : ${JSON.stringify(detail)}) + '\\n' + JSON.stringify({ http_code: status, content_type: 'text/html', url_effective: url }));
`, { mode: 0o755 });
    const obs = startObservability({ directory: path.join(dir, 'obs'), mode: 'dry-run', sources: ['teatro-auditorio-escorial'], window: { from: '2026-11-12', to: '2027-08-31' } })!;
    try {
      const result = await runIngest({ catalog: await loadCatalogFromDir(path.join(import.meta.dirname, '../data')), dataDir: path.join(dir, 'data'), now: new Date('2026-11-12T12:00:00Z'), window: { from: '2026-11-12', to: '2027-08-31' }, sourceIds: ['teatro-auditorio-escorial'], dryRun: true, observability: obs });
      obs.complete();
      expect(result.summary.sourcesFailed).toEqual([]);
      expect(result.summary.detailHydrationSucceeded).toBe(1);
      const manifest = JSON.parse(await readFile(path.join(dir, 'obs/run.json'), 'utf8'));
      expect(manifest.timings.sources['teatro-auditorio-escorial'].http).toMatchObject({ requests: 3, retries: 1, statusCounts: { '200': 2, '502': 1 } });
      expect(result.apply.written).toEqual([]);
    } finally { obs.close(); }
  });
});
