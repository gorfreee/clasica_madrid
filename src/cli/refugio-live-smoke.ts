import { getText } from '../ingestion/http.ts';
import { takeBrowserFetchAttempts } from '../ingestion/browser-fetch.ts';
import { defaultIngestWindow } from '../ingestion/dates.ts';
import {
  parseRefugioConcertArchive,
  REFUGIO_CONCERT_ARCHIVE_URL,
  refugioEventUrl,
} from '../ingestion/detail/real-hermandad-refugio.ts';
import { isSiteGroundChallenge } from '../ingestion/listing-retry.ts';
import { getSourceDefinition } from '../ingestion/registry.ts';
import { realHermandadRefugioAdapter } from '../ingestion/sources/real-hermandad-refugio.ts';
import { systemClock } from '../lib/domain/dates.ts';

/**
 * Live diagnostic for GitHub-hosted ubuntu-24.04: acquire the official
 * Refugio concert archive with the same production code path.
 * Never writes data/** and never prints cookies or page bodies.
 */
async function main(): Promise<void> {
  const now = systemClock.now();
  const source = getSourceDefinition('real-hermandad-refugio');
  const url = REFUGIO_CONCERT_ARCHIVE_URL;
  let httpChallenge = false;
  let httpStatus: number | undefined;
  const get = async (target: string) => {
    try {
      return await getText(target);
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
        httpStatus = error.status;
        if (error.status === 202) httpChallenge = true;
      }
      throw error;
    }
  };
  const ctx = {
    source,
    now,
    window: defaultIngestWindow(now),
    get,
  };

  const body = await realHermandadRefugioAdapter.fetchListing!(url, ctx);
  const browserAttempts = takeBrowserFetchAttempts(source.id);
  if (isSiteGroundChallenge(body)) {
    fail('challenge', 'el documento adquirido es un desafío SiteGround');
  }

  const parsed = parseRefugioConcertArchive(body);
  const events = await realHermandadRefugioAdapter.extract(body, url, ctx);
  if (events.length === 0) {
    fail('empty', 'el archivo de conciertos no contiene eventos');
  }

  for (const event of events) {
    if (refugioEventUrl(event.sourceUrl) !== event.sourceUrl) {
      fail('url', 'hay un evento sin URL oficial de concierto');
    }
  }

  for (const item of parsed.events) {
    if (!item.occurrence) continue;
    if (!item.occurrence.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.occurrence.date)) {
      fail('occurrence', 'hay un concierto con fecha publicada e occurrence inválida');
    }
  }

  const transport = browserAttempts.length > 0 ? 'browser' : 'http';
  console.log(JSON.stringify({
    ok: true,
    surface: 'html-archive',
    transport,
    http: {
      ...(httpStatus !== undefined ? { status: httpStatus } : { status: 200 }),
      challenge: httpChallenge,
    },
    browserRequests: browserAttempts.length,
    browserFallbacks: browserAttempts.filter((attempt) => attempt.browserFallback).length,
    events: events.length,
    datedEvents: events.filter((event) => event.observed.occurrences.length > 0).length,
  }));
}

function fail(error: string, message: string): never {
  console.error(JSON.stringify({ ok: false, error, message }));
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const challenge = /sgcaptcha|SiteGround \(captcha\)|desafío/i.test(message);
  console.error(JSON.stringify({
    ok: false,
    error: challenge ? 'challenge' : 'failed',
    message: message.slice(0, 400),
  }));
  process.exit(1);
});
