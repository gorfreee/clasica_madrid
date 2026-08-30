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

  it('un programa largo no convierte Bach, BWV, movimientos ni PAUSA en performers', () => {
    const html = `
      <article id="content">
        <h1>Atlántida Chamber Orchestra. Las 4 Estaciones</h1>
        <div class="content">
          <h4>Atlántida Chamber Orchestra<br />Maria Solozobova, violín<br />Dir. Manuel Tévar<br />Programa:<br />Johann Sebastian Bach (1685–1750)<br />Concierto para teclado y cuerdas en Fa menor, BWV 1056<br />I. Allegro moderato<br />II. Largo<br />------PAUSA-----<br />Antonio Vivaldi (1678–1741)<br />Las Cuatro Estaciones, Op. 8</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location camara rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];
    expect(names).toContain('Atlántida Chamber Orchestra');
    expect(names).toContain('Maria Solozobova');
    expect(names).toContain('Manuel Tévar');
    expect(names.some((name) => /bach/i.test(name))).toBe(false);
    expect(names.some((name) => /bwv/i.test(name))).toBe(false);
    expect(names.some((name) => /pausa/i.test(name))).toBe(false);
    expect(names.some((name) => /programa/i.test(name))).toBe(false);
    expect(names.some((name) => /allegro/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Bach/);
    expect(facts.programText).toMatch(/PAUSA/);
  });

  it('si el pairing composer/obra es ambiguo, conserva programText y no inventa la asociación', () => {
    const html = `
      <article id="content">
        <h1>CNDM. Cantoría</h1>
        <div class="content">
          <h4>CANTORÍA<br />JORGE LOSANA tenor y dirección</h4>
          <h4>¡A la fiesta!<br />José de San Juan (1687-1735)<br />¡A la fiesta, zagales! (1728)<br />Céfiros corra, pájaros vaya (1723)</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
    const facts = parseAuditorioNacionalDetail(html);
    expect(facts.programText).toMatch(/A la fiesta/);
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
    expect(facts.performers?.map((item) => item.name)).toEqual(
      expect.arrayContaining(['CANTORÍA', 'JORGE LOSANA']),
    );
  });

  it('la ficha de aplazamiento sustituye la fecha del listing', () => {
    const html = `
      <article id="content">
        <h1>CNDM. Barbara Hannigan</h1>
        <div class="content">
          <h4>CONCIERTO APLAZADO. AL 11 de ABRIL de 2027<br />BARBARA HANNIGAN soprano<br />BERTRAND CHAMAYOU piano</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
    const facts = parseAuditorioNacionalDetail(html);
    expect(facts.eventStatus).toBe('scheduled');
    expect(facts.occurrences).toEqual([
      { raw: expect.stringMatching(/11 de ABRIL de 2027/i), date: '2027-04-11' },
    ]);
    expect(facts.performers?.map((item) => item.name)).toEqual(
      expect.arrayContaining(['BARBARA HANNIGAN', 'BERTRAND CHAMAYOU']),
    );
    expect(facts.performers?.some((item) => /aplazado/i.test(item.name))).toBe(false);
  });

  it('Hannigan: el aviso de aplazamiento no es performer y el repertorio tampoco', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-hannigan.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.eventStatus).toBe('scheduled');
    expect(facts.occurrences).toEqual([
      { raw: expect.stringMatching(/11 de ABRIL de 2027/i), date: '2027-04-11' },
    ]);
    expect(facts.performers).toEqual([
      { name: 'BARBARA HANNIGAN', roleText: 'soprano' },
      { name: 'BERTRAND CHAMAYOU', roleText: 'piano' },
    ]);
    expect(names.some((name) => /abril|aplazado|2027/i.test(name))).toBe(false);
    expect(names.some((name) => /messiaen|scriabin|zorn|chants|poème|jumalattaret/i.test(name))).toBe(
      false,
    );
    expect(facts.programText).toMatch(/Messiaen/);
    expect(facts.programText).toMatch(/AL 11 de ABRIL de 2027/i);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('Beatrice Rana: Programa corta el elenco; compositores, movimientos y Pause no son performers', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-beatrice-rana.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([{ name: 'Beatrice Rana', roleText: 'piano' }]);
    expect(names.some((name) => /bach|clementi|schumann|chopin|paganini/i.test(name))).toBe(false);
    expect(names.some((name) => /pause|préambule|pierrot|allegro|programa/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/^Beatrice Rana, piano\. Programa\./);
    expect(facts.programText).toMatch(/Carnaval/);
    expect(facts.programText).toMatch(/Pause/);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('títulos Composer: Work no se publican como performers', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-composer-colon-works.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(['Orquesta Clásica Santa Cecilia', 'Andrei Yaroshinski']);
    expect(names.some((name) => /chopin|mozart|concierto|divertimento|polonesa/i.test(name))).toBe(
      false,
    );
    expect(facts.works).toEqual([
      { title: 'Divertimento en Re mayor, K. 136 (Allegro)', composerName: 'Mozart' },
      { title: 'Concierto para piano y orquesta n.º 1', composerName: 'Chopin' },
      { title: 'Andante spianato y Gran Polonesa brillante, op. 22', composerName: 'Chopin' },
      { title: 'Concierto para piano y orquesta n.º 2', composerName: 'Chopin' },
    ]);
    expect(facts.composers).toEqual([{ name: 'Mozart' }, { name: 'Chopin' }]);
  });

  it('Rafael Aguirre: Primera/Segunda Parte y títulos de obras no son performers', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-rafael-aguirre.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([{ name: 'Rafael Aguirre', roleText: 'guitarra' }]);
    expect(names.some((name) => /primera parte|segunda parte/i.test(name))).toBe(false);
    expect(names.some((name) => /lascia|invocaci[oó]n|sueño|danza/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Primera Parte/);
    expect(facts.programText).toMatch(/Segunda Parte/);
    expect(facts.programText).toMatch(/Lascia ch'io pianga/);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('Lea Desandre: sin header Programa, el lifespan del compositor abre el repertorio', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-lea-desandre.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([
      { name: 'LEA DESANDRE', roleText: 'mezzosoprano' },
      { name: 'THOMAS DUNFORD', roleText: 'laúd y tiorba' },
    ]);
    expect(names.some((name) => /idylle|charpentier|ambruys|H 450|tourment|laissez/i.test(name))).toBe(
      false,
    );
    expect(facts.programText).toMatch(/Idylle/);
    expect(facts.programText).toMatch(/H 450/);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('OCNE Satélite: elenco sin roles y programa sin frontera trivial no se mezclan', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-ocne-satelite-01.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining([
        'Áurea Corda',
        'Pablo Martín',
        'Laura Balboa',
        'Martí Varela',
        'Montserrat Egea',
        'Jorge Martínez',
      ]),
    );
    expect(names.some((name) => /boccherini|onslow|milhaud|quinteto/i.test(name))).toBe(false);
    expect(names.some((name) => /violines|viola|violonchelo|contrabajo/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Boccherini/);
    expect(facts.programText).toMatch(/G\. 339/);
    expect(facts.works).toEqual([
      { title: 'Quinteto de cuerdas en Re Mayor, G. 339', composerName: 'Luigi Boccherini' },
      {
        title: 'Quinteto de cuerdas en Mi menor núm. 30, op. 74',
        composerName: 'George Onslow',
      },
      { title: 'Quinteto de cuerdas núm. 2, op. 316', composerName: 'Darius Milhaud' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'Luigi Boccherini' },
      { name: 'George Onslow' },
      { name: 'Darius Milhaud' },
    ]);
  });

  it('OCNE Sinfónico 09: el h4 de programa no publica a Shaw ni Entr’acte como performers', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-sinfonico-09.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([
      { name: 'Orquesta Nacional de España' },
      { name: 'Anna Rakitina', roleText: 'Directora' },
      { name: 'Josu de Solaun', roleText: 'Piano' },
    ]);
    expect(names.some((name) => /shaw|entr.?acte|britten|elgar/i.test(name))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Entr’acte, para orquesta de cuerda', composerName: 'Caroline Shaw' },
      ]),
    );
    expect(facts.composers).toEqual(expect.arrayContaining([{ name: 'Caroline Shaw' }]));
  });

  it('OCNE Satélite 04: Tres canciones rusas no es performer', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-04.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining([
        'Galatea Ensemble',
        'Laura Salcedo Rubio',
        'Joaquín Fernández Díaz',
        'Coline-Marie Orliac',
      ]),
    );
    expect(names.some((name) => /canciones rusas|glinka|ibert|tedeschi|maurizio/i.test(name))).toBe(
      false,
    );
    expect(facts.works).toEqual(
      expect.arrayContaining([
        {
          title: 'Tres canciones rusas, para arpa, violín y violonchelo',
          composerName: 'Mijaíl Glinka',
        },
      ]),
    );
  });

  it('OCNE Satélite 02: Carlos Guastavino es programa, no performer', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-02.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining([
        'Poetica Ensamble',
        'Gloria Londoño',
        'Laura Godoy',
        'Gabriel Sevilla Martínez',
      ]),
    );
    expect(names.some((name) => /guastavino|jeromita|terzian|gianneo|leguizam/i.test(name))).toBe(
      false,
    );
    expect(facts.programText).toMatch(/Carlos Guastavino/);
    expect(facts.programText).toMatch(/Jeromita Linares/);
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

  it('si la ficha pospone el concierto, usa la fecha nueva y no la original', () => {
    const html = `
      <div class="wrap-content-hero">
        <h4>Domingos de Cámara</h4>
        <h1>Domingos de Cámara V 25-26</h1>
      </div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p>Concierto originalmente programado para el 5 de julio de 2026 y, posteriormente, pospuesto al 13 de septiembre de 2026.</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Sala Principal</p></div>
      </section>
    `;
    const facts = parseTeatroRealDetail(html);
    expect(facts.eventStatus).toBe('scheduled');
    expect(facts.occurrences?.[0]?.date).toBe('2026-09-13');
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
