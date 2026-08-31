/**
 * Diagnostic-only probe of www.march.es from GitHub-hosted runners.
 * Records status, redirects and cookie *names*; never prints cookie values
 * or page bodies. Not used by production ingestion.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { getText, HttpError } from '../ingestion/http.ts';

const execFileAsync = promisify(execFile);

const INGEST_UA = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INGEST_HEADERS = {
  accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'user-agent': INGEST_UA,
};
const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'user-agent': BROWSER_UA,
};

const LISTING = 'https://www.march.es/es/madrid/conciertos';
const DETAIL = 'https://www.march.es/es/madrid/concierto/andromeda-perseo';
const TIMEOUT_MS = 15_000;

type Hop = {
  url: string;
  status?: number;
  location?: string | null;
  setCookieNames: string[];
  diagnosticHeaders: Record<string, string>;
  httpVersion?: string;
  tlsProtocol?: string;
  error?: string;
};

type ProbeRow = {
  client: string;
  notes: string;
  hops: Hop[];
  reachedListingHeading?: boolean;
};

type InternalHop = Hop & { cookie?: string };

const rows: ProbeRow[] = [];

const DIAGNOSTIC_HEADER_NAMES = [
  'server',
  'via',
  'content-type',
  'content-length',
  'retry-after',
  'x-cache',
  'x-cdn',
  'cf-ray',
  'cf-mitigated',
  'x-request-id',
  'x-protected-by',
  'x-sucuri-id',
  'x-akamai-transformed',
];

function cookieNamesFromPairs(pairs: string[]): string[] {
  return pairs.map((pair) => pair.split('=', 1)[0]).filter((name): name is string => Boolean(name));
}

function cookiePairs(header: string | string[] | undefined): string[] {
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const pairs: string[] = [];
  for (const raw of values) {
    const pair = raw.split(';', 1)[0]?.trim() ?? '';
    if (pair.includes('=')) pairs.push(pair);
  }
  return pairs;
}

function pickDiagnostic(headers: Headers | IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = headers instanceof Headers ? headers.get(name) : headers[name];
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (typeof text === 'string' && text) out[name] = text;
  }
  return out;
}

function publicHop(hop: InternalHop): Hop {
  const { cookie: _cookie, ...rest } = hop;
  return rest;
}

function summarizeHop(hop: Hop): string {
  const cookie = hop.setCookieNames.length ? hop.setCookieNames.join(',') : '-';
  const loc = hop.location ?? '-';
  const server = hop.diagnosticHeaders.server ?? '-';
  const extra = hop.httpVersion ? ` http/${hop.httpVersion}` : '';
  const tls = hop.tlsProtocol ? ` tls=${hop.tlsProtocol}` : '';
  const err = hop.error ? ` error=${hop.error}` : '';
  return `${hop.status ?? 'err'} loc=${loc} set-cookie=${cookie} server=${server}${extra}${tls}${err}`;
}

function shouldReplay(hop: InternalHop): hop is InternalHop & { cookie: string; location: string } {
  return Boolean(
    hop.cookie
    && hop.location
    && hop.status
    && hop.status >= 300
    && hop.status < 400,
  );
}

async function fetchInternal(url: string, headers: Record<string, string>): Promise<InternalHop> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'manual', headers, signal: controller.signal });
    const pairs = cookiePairs(response.headers.getSetCookie?.() ?? response.headers.get('set-cookie') ?? undefined);
    await response.body?.cancel();
    return {
      url,
      status: response.status,
      location: response.headers.get('location'),
      setCookieNames: cookieNamesFromPairs(pairs),
      diagnosticHeaders: pickDiagnostic(response.headers),
      cookie: pairs.length ? pairs.join('; ') : undefined,
    };
  } catch (error) {
    return {
      url,
      setCookieNames: [],
      diagnosticHeaders: {},
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollow(url: string, headers: Record<string, string>): Promise<Hop[]> {
  const first = await fetchInternal(url, headers);
  const hops = [first];
  if (shouldReplay(first)) {
    const next = new URL(first.location, url).href;
    hops.push(await fetchInternal(next, { ...headers, cookie: first.cookie }));
  }
  return hops.map(publicHop);
}

function httpsInternal(url: string, headers: Record<string, string>): Promise<InternalHop> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const request = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const tls = response.socket as TLSSocket | undefined;
        const pairs = cookiePairs(response.headers['set-cookie']);
        response.resume();
        resolve({
          url,
          status: response.statusCode,
          location: typeof response.headers.location === 'string' ? response.headers.location : null,
          setCookieNames: cookieNamesFromPairs(pairs),
          diagnosticHeaders: pickDiagnostic(response.headers),
          httpVersion: response.httpVersion,
          tlsProtocol: tls?.getProtocol() ?? undefined,
          cookie: pairs.length ? pairs.join('; ') : undefined,
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ url, setCookieNames: [], diagnosticHeaders: {}, error: 'timeout' });
    });
    request.on('error', (error) => {
      resolve({ url, setCookieNames: [], diagnosticHeaders: {}, error: `${error.name}: ${error.message}` });
    });
    request.end();
  });
}

async function httpsFollow(url: string, headers: Record<string, string>): Promise<Hop[]> {
  const first = await httpsInternal(url, headers);
  const hops = [first];
  if (shouldReplay(first)) {
    const next = new URL(first.location, url).href;
    hops.push(await httpsInternal(next, { ...headers, cookie: first.cookie }));
  }
  return hops.map(publicHop);
}

function parseCurlStdout(raw: string): InternalHop & { writeOut?: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const writeOut = /http_version=([\d.]+)\s*$/.exec(normalized)?.[1];
  const headerText = writeOut ? normalized.slice(0, normalized.lastIndexOf('http_version=')) : normalized;
  const block = headerText.trim().split('\n\n')[0] ?? '';
  const lines = block.split('\n');
  const statusLine = lines.find((line) => /^HTTP\//i.test(line)) ?? '';
  const status = Number(/HTTP\/[\d.]+ (\d+)/i.exec(statusLine)?.[1]);
  const headerMap: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    (headerMap[name] ??= []).push(value);
  }
  const pairs = cookiePairs(headerMap['set-cookie']);
  return {
    url: '',
    status: Number.isFinite(status) ? status : undefined,
    location: headerMap.location?.[0] ?? null,
    setCookieNames: cookieNamesFromPairs(pairs),
    diagnosticHeaders: pickDiagnostic(Object.fromEntries(
      Object.entries(headerMap).map(([key, values]) => [key, values.join(', ')]),
    )),
    httpVersion: writeOut,
    cookie: pairs.length ? pairs.join('; ') : undefined,
  };
}

async function curlInternal(url: string, extraArgs: string[], headers: Record<string, string>): Promise<InternalHop> {
  const headerArgs = Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]);
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-D', '-', '-o', os.devNull, '--max-time', '15', '-w', 'http_version=%{http_version}\n', ...extraArgs, ...headerArgs, url],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    return { ...parseCurlStdout(stdout), url };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const parsed = err.stdout ? parseCurlStdout(err.stdout) : undefined;
    return {
      url,
      ...(parsed ?? { setCookieNames: [], diagnosticHeaders: {} }),
      error: (err.stderr || err.message || String(error)).trim().slice(0, 240),
    };
  }
}

async function curlFollow(url: string, extraArgs: string[], headers: Record<string, string>): Promise<Hop[]> {
  const first = await curlInternal(url, extraArgs, headers);
  const hops = [first];
  if (shouldReplay(first)) {
    const next = new URL(first.location, url).href;
    hops.push(await curlInternal(next, extraArgs, { ...headers, cookie: first.cookie }));
  }
  return hops.map(publicHop);
}

function pushRow(client: string, notes: string, hops: Hop[], extra?: Partial<ProbeRow>): ProbeRow {
  const row: ProbeRow = { client, notes, hops, ...extra };
  rows.push(row);
  return row;
}

function anySuccess(row: ProbeRow): boolean {
  return row.hops.some((hop) => hop.status !== undefined && hop.status >= 200 && hop.status < 300);
}

async function maybeConfirmProduction(listingWorked: boolean): Promise<void> {
  if (!listingWorked) {
    pushRow('node-getText', 'skipped: no 2xx listing hop; do not retry a deterministic 403', []);
    return;
  }
  try {
    const body = await getText(LISTING, TIMEOUT_MS);
    pushRow(
      'node-getText',
      'production client after a successful diagnostic hop',
      [{
        url: LISTING,
        status: 200,
        location: null,
        setCookieNames: [],
        diagnosticHeaders: { 'content-length': String(body.length) },
      }],
      { reachedListingHeading: /Conciertos en Madrid/.test(body) },
    );
  } catch (error) {
    pushRow('node-getText', 'production client', [{
      url: LISTING,
      status: error instanceof HttpError ? error.status : undefined,
      location: null,
      setCookieNames: [],
      diagnosticHeaders: {},
      error: error instanceof Error ? error.message : String(error),
    }]);
  }
}

async function main(): Promise<void> {
  const curlVersion = await execFileAsync('curl', ['--version'], { timeout: 5_000 })
    .then(({ stdout }) => stdout.split('\n')[0]?.trim())
    .catch((error: Error) => error.message);

  const listingRows = [
    pushRow(
      'node-fetch-ingest-headers',
      'same headers as getText; cookie replay only if 3xx+Set-Cookie',
      await fetchFollow(LISTING, INGEST_HEADERS),
    ),
    pushRow(
      'node-https-ingest-headers',
      'Node https GET; TLS fingerprint distinct from undici',
      await httpsFollow(LISTING, INGEST_HEADERS),
    ),
    pushRow(
      'node-https-browser-headers',
      'diagnostic Accept / Accept-Language / UA only',
      await httpsFollow(LISTING, BROWSER_HEADERS),
    ),
    pushRow(
      'curl-default',
      'runner curl, no -L, ingest headers',
      await curlFollow(LISTING, [], INGEST_HEADERS),
    ),
    pushRow(
      'curl-http1.1',
      'forced HTTP/1.1, ingest headers',
      await curlFollow(LISTING, ['--http1.1'], INGEST_HEADERS),
    ),
    pushRow(
      'curl-browser-headers',
      'diagnostic browser headers; not a production candidate by itself',
      await curlFollow(LISTING, [], BROWSER_HEADERS),
    ),
  ];

  const listingWorked = listingRows.some(anySuccess);
  await maybeConfirmProduction(listingWorked);

  if (listingWorked) {
    pushRow(
      'node-fetch-detail',
      'Andrómeda ficha; only after listing success',
      await fetchFollow(DETAIL, INGEST_HEADERS),
    );
    pushRow(
      'node-fetch-second-listing',
      'second listing request after success; watch for a follow-up 403',
      await fetchFollow(LISTING, INGEST_HEADERS),
    );
  }

  for (const [url, client] of [
    ['https://www.march.es/robots.txt', 'curl-robots'],
    ['https://canal.march.es/es', 'curl-canal-control'],
    ['https://www2.march.es/invitaciones/', 'curl-www2-invitaciones'],
    ['https://recursos.march.es/', 'curl-recursos'],
  ] as const) {
    pushRow(client, 'first hop only; body discarded', [publicHop(await curlInternal(url, [], INGEST_HEADERS))]);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runner: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      curl: curlVersion,
    },
    listingWorked,
    rows,
  };

  const jsonPath = process.env.MARCH_PROBE_OUT ?? 'ingestion/reports/march-http-probe.json';
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const lines = [
    `### March HTTP probe (${process.platform} ${process.arch}, Node ${process.version})`,
    '',
    `| client | hops |`,
    `|---|---|`,
    ...rows.map((row) => `| \`${row.client}\` | ${row.hops.length ? row.hops.map(summarizeHop).join(' → ') : row.notes} |`),
    '',
    listingWorked
      ? 'At least one listing variant returned 2xx.'
      : 'No listing variant returned 2xx from this runner.',
    '',
  ];
  console.log(lines.join('\n'));
}

await main();
