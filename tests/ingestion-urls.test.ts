import { describe, expect, it } from 'vitest';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import {
  madridVgnextoid,
  normalizeUrl,
  sourceUrlKind,
  urlIdentifiesSingleEvent,
  urlsEquivalent,
} from '../src/ingestion/urls.ts';
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

describe('sourceUrlKind', () => {
  it('trata agendas permanentes, homepages y listados como listing', () => {
    expect(sourceUrlKind('https://corofrancispoulenc.com/agenda')).toBe('listing');
    expect(sourceUrlKind('https://corofrancispoulenc.com/agenda/')).toBe('listing');
    expect(sourceUrlKind('https://corofrancispoulenc.com/')).toBe('listing');
    expect(sourceUrlKind('https://example.org/eventos')).toBe('listing');
    expect(sourceUrlKind('https://example.org/programacion')).toBe('listing');
    expect(sourceUrlKind('https://example.org/conciertos')).toBe('listing');
    expect(sourceUrlKind('https://auditorionacional.inaem.gob.es/es/programacion')).toBe('listing');
    expect(sourceUrlKind('https://caixaforum.org/es/madrid/agenda')).toBe('listing');
    expect(sourceUrlKind('https://example.org/agenda?page=2')).toBe('listing');
    expect(urlIdentifiesSingleEvent('https://corofrancispoulenc.com/agenda')).toBe(false);
  });

  it('trata slugs de colección multi-palabra como listing, no como ficha', () => {
    expect(
      sourceUrlKind('https://www.museocasadelamoneda.es/actividades/conciertos-de-tarde'),
    ).toBe('listing');
    expect(sourceUrlKind('https://example.org/actividades/conciertos-de-tarde')).toBe('listing');
    expect(sourceUrlKind('https://example.org/eventos-octubre')).toBe('listing');
    expect(sourceUrlKind('https://example.org/eventos-madrid')).toBe('listing');
    expect(sourceUrlKind('https://example.org/actividades-culturales')).toBe('listing');
    expect(sourceUrlKind('https://example.org/programacion-2026')).toBe('listing');
    expect(sourceUrlKind('https://example.org/programacion-otono')).toBe('listing');
    expect(sourceUrlKind('https://example.org/agenda-cultural')).toBe('listing');
    expect(urlIdentifiesSingleEvent('https://example.org/actividades/conciertos-de-tarde')).toBe(
      false,
    );
  });

  it('no toma cualquier segmento de tres palabras como identificador de evento', () => {
    expect(sourceUrlKind('https://example.org/musica-en-madrid')).toBe('event-detail');
    expect(
      sourceUrlKind('https://example.org/actividades/ciclo-de-camara/conciertos-de-tarde'),
    ).toBe('listing');
  });

  it('trata fichas con id, slug largo o segmento no genérico como event-detail', () => {
    expect(
      sourceUrlKind(
        'https://www.coiim.es/eventos/recital-de-violin-y-piano-de-bruch-a-rachmaninoff-paisajes-del-romanticismo',
      ),
    ).toBe('event-detail');
    expect(sourceUrlKind('https://caixaforum.org/es/madrid/p/a-delta-trio-madrid')).toBe('event-detail');
    expect(sourceUrlKind('https://www.teatroreal.es/es/espectaculo/demo')).toBe('event-detail');
    expect(sourceUrlKind('https://cndm.inaem.gob.es/node/23846')).toBe('event-detail');
    expect(sourceUrlKind('https://example.org/eventos-12345')).toBe('event-detail');
    expect(sourceUrlKind('https://example.org/conciertos/recital-de-piano-schubert')).toBe(
      'event-detail',
    );
    expect(sourceUrlKind('https://www.parroquia.example/conciertos/bach')).toBe('event-detail');
    expect(sourceUrlKind('https://example.org/evento?id=12')).toBe('event-detail');
    expect(
      sourceUrlKind(
        'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD',
      ),
    ).toBe('event-detail');
    expect(urlIdentifiesSingleEvent('https://www.teatroreal.es/es/espectaculo/bayreuth')).toBe(true);
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
