import { describe, expect, it } from 'vitest';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { madridVgnextoid, normalizeUrl, urlsEquivalent } from '../src/ingestion/urls.ts';
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

  it('trata como la misma ficha de Madrid dos URLs con el mismo vgnextoid', () => {
    const portal =
      'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Ciudad-Lineal/Retransmision-del-Pleno-en-directo/Actuacion-musica-Musica-clasica/?vgnextchannel=cd0a32e941f22610VgnVCM1000008a4a900aRCRD&vgnextfmt=default&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD';
    const listing =
      'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD';
    expect(urlsEquivalent(portal, listing)).toBe(true);
    expect(madridVgnextoid(portal)).toBe('aab47760175ff910vgnvcm100000891ecb1arcrd');
    expect(
      urlsEquivalent(
        listing,
        'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=0c4c7760175ff910VgnVCM100000891ecb1aRCRD',
      ),
    ).toBe(false);
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
        performers: [],
        composers: [],
        works: [],
      },
    };
    expect(normalizeRawEvent(raw)?.sourceUrl).toBe('https://www.teatroreal.es/es/espectaculo/bayreuth');
  });
});
