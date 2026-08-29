import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditorioNacionalAdapter } from '../src/ingestion/sources/auditorio-nacional.ts';
import { madridDatosAdapter } from '../src/ingestion/sources/madrid-datos.ts';
import { teatroRealAdapter } from '../src/ingestion/sources/teatro-real.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { TEST_NOW } from './helpers.ts';
import type { AdapterContext } from '../src/ingestion/types.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');

function ctx(sourceId: string): AdapterContext {
  return {
    source: getSourceDefinition(sourceId),
    now: TEST_NOW,
    get: async () => {
      throw new Error('no debe pedirse red en tests de fixtures');
    },
  };
}

describe('adapter Auditorio Nacional (JSON)', () => {
  it('agrupa representaciones del mismo URL y extrae Sala Sinfónica / Sala de Cámara', async () => {
    const body = await readFile(path.join(fixtures, 'auditorio-events.json'), 'utf8');
    const events = auditorioNacionalAdapter.extract(body, 'https://example.test/events.json', ctx('auditorio-nacional'));
    expect(events).toHaveLength(2);
    const ocne = events.find((event) => event.observed.title === 'OCNE. Sinfónico 01');
    expect(ocne?.externalId).toBe('094859ec8b69466481bb839d02a9af07');
    expect(ocne?.sourceUrl).toContain('/ocne-sinfonico-01-1');
    expect(ocne?.observed.venueText).toBe('Sala Sinfónica');
    expect(ocne?.observed.occurrences.map((item) => item.date)).toEqual(['2026-09-18', '2026-09-19']);
    const chamber = events.find((event) => event.observed.title.includes('Satélite'));
    expect(chamber?.observed.venueText).toBe('Sala de Cámara');
    expect(chamber?.externalId).toBe('ocne-satelite-01-evoluciones');
  });

  it('falla si el documento no es un array', () => {
    expect(() =>
      auditorioNacionalAdapter.extract('{"events":[]}', 'https://example.test/events.json', ctx('auditorio-nacional')),
    ).toThrow(/array/);
  });

  it('falla si hay objetos pero ninguno es un evento reconocible', () => {
    expect(() =>
      auditorioNacionalAdapter.extract('[{"foo":1}]', 'https://example.test/events.json', ctx('auditorio-nacional')),
    ).toThrow(/no contiene eventos/);
  });

  it('un calendario JSON vacío es un resultado válido', () => {
    expect(auditorioNacionalAdapter.extract('[]', 'https://example.test/events.json', ctx('auditorio-nacional'))).toEqual(
      [],
    );
  });
});

describe('adapter Teatro Real (HTML)', () => {
  it('lee días boxMM-YYYY-DD, horas y agrupa por espectáculo', async () => {
    const body = await readFile(path.join(fixtures, 'teatro-real-calendario.html'), 'utf8');
    const events = teatroRealAdapter.extract(body, 'https://www.teatroreal.es/es/calendario', ctx('teatro-real'));
    expect(events).toHaveLength(3);
    const bayreuth = events.find((event) => event.sourceUrl.includes('bayreuth'));
    expect(bayreuth?.observed.title).toContain('Bayreuth');
    expect(bayreuth?.observed.occurrences).toEqual([
      { raw: '2026-09-03T19:30', date: '2026-09-03', time: '19:30' },
    ]);
    expect(bayreuth?.observed.venueText).toBe('Teatro Real');
    const mini = events.find((event) => event.sourceUrl.includes('miniclasica'));
    expect(mini?.observed.occurrences.map((item) => item.time)).toEqual(['11:00', '13:00']);
    expect(mini?.observed.venueText).toBe('Real Teatro de Retiro');
  });

  it('falla si falta la estructura del calendario', () => {
    expect(() =>
      teatroRealAdapter.extract('<html><body>sin calendario</body></html>', 'https://www.teatroreal.es/es/calendario', ctx('teatro-real')),
    ).toThrow(/calendario esperado/);
  });

  it('falla si hay días del calendario pero el markup interno ya no es interpretable', () => {
    const body = `
      <div id="accordion-calendar">
        <div class="item-box" id="box09-2026-03">
          <div class="contentbox">
            <article class="show-card">
              <p class="headline">Bayreuth</p>
              <time>19:30</time>
            </article>
          </div>
        </div>
      </div>
    `;
    expect(() =>
      teatroRealAdapter.extract(body, 'https://www.teatroreal.es/es/calendario', ctx('teatro-real')),
    ).toThrow(/parece tener eventos/);
  });

  it('un calendario con días pero sin eventos no es un error', () => {
    const body = `
      <div id="accordion-calendar">
        <div class="item-box" id="box09-2026-03">
          <h2 class="dia-sidebar-calendario">Jueves 03</h2>
        </div>
        <div class="item-box" id="box09-2026-04">
          <h2 class="dia-sidebar-calendario">Viernes 04</h2>
        </div>
      </div>
    `;
    expect(teatroRealAdapter.extract(body, 'https://www.teatroreal.es/es/calendario', ctx('teatro-real'))).toEqual([]);
  });
});

describe('adapter Madrid datos (JSON-LD)', () => {
  it('se queda solo con música puntual que tiene título, URL, fecha, hora y lugar', async () => {
    const body = await readFile(path.join(fixtures, 'madrid-agenda.json'), 'utf8');
    const events = madridDatosAdapter.extract(body, 'https://datos.madrid.es/agenda.json', ctx('madrid-datos'));
    expect(events).toHaveLength(1);
    expect(events[0]?.observed.title).toContain('Teatro Real');
    expect(events[0]?.externalId).toBe('50390001');
    expect(events[0]?.sourceUrl.startsWith('https://')).toBe(true);
    expect(events[0]?.observed.occurrences[0]?.date).toBe('2026-09-15');
    expect(events[0]?.observed.occurrences[0]?.time).toBe('19:30');
    expect(events[0]?.observed.accessText).toBe('paid');
  });

  it('falla si no hay @graph', () => {
    expect(() =>
      madridDatosAdapter.extract('{"items":[]}', 'https://datos.madrid.es/agenda.json', ctx('madrid-datos')),
    ).toThrow(/@graph/);
  });

  it('un @graph vacío es un resultado válido', () => {
    expect(madridDatosAdapter.extract('{"@graph":[]}', 'https://datos.madrid.es/agenda.json', ctx('madrid-datos'))).toEqual(
      [],
    );
  });

  it('falla si hay ítems pero ninguno es música usable', () => {
    expect(() =>
      madridDatosAdapter.extract(
        JSON.stringify({
          '@graph': [{ '@type': 'https://datos.madrid.es/egob/kos/actividades/Exposiciones', title: 'Expo' }],
        }),
        'https://datos.madrid.es/agenda.json',
        ctx('madrid-datos'),
      ),
    ).toThrow(/no hay eventos de música/);
  });
});
