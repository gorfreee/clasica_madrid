import { describe, expect, it } from 'vitest';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { normalizeUrl, urlsEquivalent } from '../src/ingestion/urls.ts';
import type { RawEvent } from '../src/ingestion/types.ts';

describe('normalizeUrl', () => {
  it('ignora trailing slash, fragment y casing del hostname', () => {
    expect(normalizeUrl('https://www.TeatroReal.es/es/espectaculo/bayreuth/#programa')).toBe(
      'https://www.teatroreal.es/es/espectaculo/bayreuth',
    );
    expect(
      urlsEquivalent(
        'https://WWW.teatroreal.es/es/espectaculo/bayreuth/',
        'https://www.teatroreal.es/es/espectaculo/bayreuth#cast',
      ),
    ).toBe(true);
  });

  it('conserva query params que pueden formar parte de la identidad', () => {
    expect(normalizeUrl('https://example.org/evento?id=12&lang=es#top')).toBe(
      'https://example.org/evento?id=12&lang=es',
    );
    expect(urlsEquivalent('https://example.org/evento?id=12', 'https://example.org/evento?id=13')).toBe(false);
  });
});

describe('normalización de URLs en hechos', () => {
  it('deja la URL del evento en forma canónica antes de identidad o citas', () => {
    const raw: RawEvent = {
      sourceId: 'teatro-real',
      sourceUrl: 'https://WWW.teatroreal.es/es/espectaculo/bayreuth/#info',
      observed: {
        title: 'Bayreuth',
        occurrences: [{ raw: '2026-09-03T19:30', date: '2026-09-03', time: '19:30' }],
        venueText: 'Teatro Real',
      },
    };
    expect(normalizeRawEvent(raw)?.sourceUrl).toBe('https://www.teatroreal.es/es/espectaculo/bayreuth');
  });
});
