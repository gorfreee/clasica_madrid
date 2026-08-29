import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import { parseTeatroRealDetail } from '../src/ingestion/detail/teatro-real.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';

const detailDir = path.join(import.meta.dirname, 'fixtures', 'ingestion', 'detail');

describe('parser de ficha Auditorio Nacional', () => {
  it('extrae performers, obras, compositores, sala y precios del excerpt', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-ocne-sinfonico-01.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);

    expect(facts.venueText).toBe('Sala Sinfónica');
    expect(facts.accessText).toMatch(/40, 36, 28, 20 y 13/);
    expect(facts.programText).toMatch(/Kent Nagano/);
    expect(facts.programText).toMatch(/Mahler/);
    expect(facts.performers).toEqual([
      { name: 'Orquesta y Coro Nacionales de España' },
      { name: 'Kent Nagano', roleText: 'director' },
      { name: 'Jane Archibal', roleText: 'soprano' },
      { name: 'Christina Bock', roleText: 'mezzosoprano' },
    ]);
    expect(facts.composers).toEqual([{ name: 'Mikel Urquiza' }, { name: 'Gustav Mahler' }]);
    expect(facts.works).toEqual([
      { title: 'Deseo tomó delicia', composerName: 'Mikel Urquiza' },
      { title: 'Sinfonía núm. 2 en Do menor, «Resurrección»', composerName: 'Gustav Mahler' },
    ]);
  });

  it('entiende la ficha Plone con h4 y columna Info', () => {
    const html = `
      <article id="content">
        <h1>OCNE. Sinfónico 01</h1>
        <div class="content">
          <h4>Orquesta y Coro Nacionales de España<br />Kent Nagano, director</h4>
          <h4>Mikel Urquiza<br />Deseo tomó delicia<br /><br />Gustav Mahler<br />Sinfonía núm. 2</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location sinfonica rightColumn__item__text">Sala Sinfónica</span>
          </p>
          <div class="rightColumn__item">
            <label class="rightColumn__item__label">Entradas</label>
            <div class="rightColumn__item__text">Viernes y Sábado: 40 €</div>
          </div>
        </div>
      </article>
    `;
    const facts = parseAuditorioNacionalDetail(html);
    expect(facts.venueText).toBe('Sala Sinfónica');
    expect(facts.accessText).toBe('Viernes y Sábado: 40 €');
    expect(facts.performers).toEqual([
      { name: 'Orquesta y Coro Nacionales de España' },
      { name: 'Kent Nagano', roleText: 'director' },
    ]);
    expect(facts.works).toEqual([
      { title: 'Deseo tomó delicia', composerName: 'Mikel Urquiza' },
      { title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' },
    ]);
    expect(facts.composers).toEqual([{ name: 'Mikel Urquiza' }, { name: 'Gustav Mahler' }]);
  });

  it('no inventa performers, composers ni works si la ficha no los declara', () => {
    const facts = parseAuditorioNacionalDetail(
      '<article><h1>OCNE. Sinfónico 01</h1><p>Concierto de temporada.</p></article>',
    );
    expect(facts.performers).toEqual([]);
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
    expect(facts.programText).toBeUndefined();
  });

  it('falla si el HTML no es una ficha reconocible', () => {
    expect(() => parseAuditorioNacionalDetail('<html><body>sin ficha</body></html>')).toThrow(
      /estructura esperada/,
    );
  });
});

describe('parser de ficha Teatro Real', () => {
  it('extrae descripción, categoría, performers, programa y obras del excerpt', async () => {
    const html = await readFile(path.join(detailDir, 'teatro-real-concierto-navidad.excerpt.html'), 'utf8');
    const facts = parseTeatroRealDetail(html);

    expect(facts.categoryText).toBe('También en el Real');
    expect(facts.description).toMatch(/villancicos más famosos/);
    expect(facts.programText).toMatch(/Sleigh Ride/);
    expect(facts.performers).toEqual([
      { name: 'ORQUESTA CLÁSICA SANTA CECILIA' },
      { name: 'Kynan Johns', roleText: 'director' },
    ]);
    expect(facts.works).toEqual([
      { title: 'Sleigh Ride', composerName: 'L. Anderson' },
      { title: 'Hallelujah', composerName: 'L. Cohen' },
      { title: 'Happy Christmas. War is Over', composerName: 'J. Lennon, Y. Ono' },
      { title: 'White Christmas', composerName: 'I. Berlin' },
      { title: 'Feliz Navidad', composerName: 'J. Feliciano' },
      { title: 'New York, New York', composerName: 'F. Sinatra' },
    ]);
    expect(facts.composers?.map((item) => item.name)).toEqual([
      'L. Anderson',
      'L. Cohen',
      'J. Lennon, Y. Ono',
      'I. Berlin',
      'J. Feliciano',
      'F. Sinatra',
    ]);
  });

  it('en una ficha Drupal conserva el programa como texto y no adivina obras de un párrafo suelto', () => {
    const html = `
      <div class="wrap-content-hero">
        <h4>También en el Real</h4>
        <h3>PRESENTADO POR: Excelentia Música</h3>
        <h1>CONCIERTO DE NAVIDAD</h1>
      </div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free collapsible-mobile">
          <p>Vive un concierto único con solistas y orquesta sinfónica.</p>
          <hr />
          <p>ORQUESTA CLÁSICA SANTA CECILIA<br />Director : Kynan Johns<br />Francesco Castoro, tenor</p>
          <hr />
          <p>1. Sleigh Ride (L. Anderson) 2. Hallelujah (L. Cohen)</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Sala Principal</p></div>
      </section>
    `;
    const facts = parseTeatroRealDetail(html);
    expect(facts.categoryText).toBe('También en el Real');
    expect(facts.organizerText).toBe('Excelentia Música');
    expect(facts.venueText).toBe('Sala Principal');
    expect(facts.description).toMatch(/orquesta sinfónica/);
    expect(facts.programText).toMatch(/Sleigh Ride/);
    expect(facts.performers).toEqual([
      { name: 'ORQUESTA CLÁSICA SANTA CECILIA' },
      { name: 'Kynan Johns', roleText: 'director' },
      { name: 'Francesco Castoro', roleText: 'tenor' },
    ]);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('no inventa un programa a partir del título', () => {
    const facts = parseTeatroRealDetail(
      '<article><h1>CONCIERTO DE NAVIDAD</h1><p>También en el Real</p></article>',
    );
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
    expect(facts.performers).toEqual([]);
    expect(facts.categoryText).toBe('También en el Real');
  });

  it('falla si el HTML no es una ficha reconocible', () => {
    expect(() => parseTeatroRealDetail('<div class="home">Teatro Real</div>')).toThrow(/estructura esperada/);
  });
});

describe('normalización de hechos observados', () => {
  it('colapsa espacios y no rellena listas vacías', () => {
    const normalized = normalizeRawEvent({
      sourceId: 'auditorio-nacional',
      sourceUrl: 'https://example.org/evento',
      observed: {
        title: '  OCNE  ',
        occurrences: [{ raw: '2026-09-18T19:30:00+02:00' }],
        programText: '  Mahler   2  ',
        performers: [{ name: '  Kent Nagano  ', roleText: ' director ' }],
        composers: [],
        works: [{ title: '  Sinfonía 2  ', composerName: '  Gustav Mahler  ' }],
      },
    });
    expect(normalized?.programText).toBe('Mahler 2');
    expect(normalized?.performers).toEqual([{ name: 'Kent Nagano', roleText: 'director' }]);
    expect(normalized?.works).toEqual([{ title: 'Sinfonía 2', composerName: 'Gustav Mahler' }]);
    expect(
      normalizeRawEvent({
        sourceId: 'x',
        sourceUrl: 'https://example.org/e',
        observed: {
          title: 'Solo título',
          occurrences: [{ raw: '2026-09-18T19:30:00+02:00' }],
          ...emptyObservedLists(),
        },
      })?.performers,
    ).toEqual([]);
  });
});
