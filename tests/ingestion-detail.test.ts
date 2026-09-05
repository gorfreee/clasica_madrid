import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import { parseMadridDatosDetail } from '../src/ingestion/detail/madrid-datos.ts';
import { parseTeatroRealDetail } from '../src/ingestion/detail/teatro-real.ts';
import { matchComposer } from '../src/ingestion/knowledge/composers.ts';
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
    expect(facts.programText).not.toMatch(/Maria Solozobova/);
  });

  it('no convierte solistas repetidos dentro del programa oficial de Ainhoa Arteta en obras', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ainhoa-arteta-cast-in-program.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);

    expect(facts.performers).toEqual([
      { name: 'Atlántida Chamber Orchestra' },
      { name: 'Ainhoa Arteta', roleText: 'soprano' },
      { name: 'Jasper Chang', roleText: 'violín' },
      { name: 'Manuel Tévar', roleText: 'director' },
    ]);
    expect(facts.works).toEqual([
      {
        title: 'Introducción y Rondó Caprichoso, Op. 28es',
        composerName: 'Camille Saint-Saëns (1835–1921)',
      },
      {
        title: 'Cuatro últimas canciones (Vier letzte Lieder)',
        composerName: 'Richard Strauss (1864–1949)',
      },
      {
        title: 'Suite de El lago de los cisnes, Op. 20a',
        composerName: 'Piotr Ilich Tchaikovsky (1840–1893)',
      },
    ]);
  });

  it('omite elenco incrustado en el programa FOSC en vez de atribuirlo como obras o compositor', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-fosc-cast-in-program.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);

    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Orquesta Celeste Classic' },
        { name: 'Coro y Escolanía Maravillas' },
      ]),
    );
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
    expect(facts.programText).toMatch(/Times and seasons/);
  });

  it('conserva una obra cuya instrumentación menciona soprano y orquesta', () => {
    const facts = parseAuditorioNacionalDetail(`
      <article id="content">
        <h1>Concierto vocal</h1>
        <div class="content">
          <h4>Óscar Esplá<br />Canciones playeras, para soprano y orquesta</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `);

    expect(facts.works).toEqual([
      { title: 'Canciones playeras, para soprano y orquesta', composerName: 'Óscar Esplá' },
    ]);
  });

  it('un compositor con lifespan agrupa las villancicos siguientes y omite el título del bloque', () => {
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
    expect(facts.composers).toEqual([{ name: 'José de San Juan (1687-1735)' }]);
    expect(facts.works).toEqual([
      { title: '¡A la fiesta, zagales! (1728)', composerName: 'José de San Juan (1687-1735)' },
      { title: 'Céfiros corra, pájaros vaya (1723)', composerName: 'José de San Juan (1687-1735)' },
    ]);
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
    expect(facts.programText).not.toMatch(/AL 11 de ABRIL de 2027/i);
    expect(facts.composers).toEqual([
      { name: 'Olivier Messiaen (1908-1992)' },
      { name: 'Alexander Scriabin (1872-1915)' },
      { name: 'John Zorn (1953)' },
    ]);
    expect(facts.works).toEqual([
      { title: 'Chants de terre et de ciel (1938)', composerName: 'Olivier Messiaen (1908-1992)' },
      { title: 'Poème-nocturne, op. 61 (1911)', composerName: 'Alexander Scriabin (1872-1915)' },
      { title: 'Vers la flamme, op. 72 (1914)', composerName: 'Alexander Scriabin (1872-1915)' },
      { title: 'Jumalattaret ** (2012)', composerName: 'John Zorn (1953)' },
    ]);
  });

  it('Beatrice Rana: Programa corta el elenco; compositores, movimientos y Pause no son performers', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-beatrice-rana.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([{ name: 'Beatrice Rana', roleText: 'piano' }]);
    expect(names.some((name) => /bach|clementi|schumann|chopin|paganini/i.test(name))).toBe(false);
    expect(names.some((name) => /pause|préambule|pierrot|allegro|programa/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/^Programa\./);
    expect(facts.programText).not.toMatch(/Beatrice Rana/);
    expect(facts.programText).toMatch(/Carnaval/);
    expect(facts.programText).toMatch(/Pause/);
    expect(facts.composers).toEqual([
      { name: 'Johann Sebastian Bach' },
      { name: 'Muzio Clementi' },
      { name: 'Robert Schumann' },
    ]);
    expect(facts.works).toEqual([
      { title: 'Concierto italiano en fa mayor, BWV 971', composerName: 'Johann Sebastian Bach' },
      {
        title: 'Sonata en sol menor, Op. 50 n.º 3 «Didone abbandonata»',
        composerName: 'Muzio Clementi',
      },
      {
        title: 'Carnaval, escenas mignonnes sobre cuatro notas, Op. 9',
        composerName: 'Robert Schumann',
      },
      {
        title: 'Marche des «Davidsbündler» contre les Philistins',
        composerName: 'Robert Schumann',
      },
    ]);
  });

  it('Excelentia Tres Tenores: roles entre paréntesis son elenco; las arias no se inventan como obras', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-excelentia-tres-tenores.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);

    expect(facts.venueText).toBe('Sala de Cámara');
    expect(facts.accessText).toMatch(/65 y 58/);
    expect(facts.performers).toEqual([
      { name: 'Miguel Borrallo', roleText: 'Tenor' },
      { name: 'Eduardo Sandoval', roleText: 'Tenor' },
      { name: 'Sergio Escobar', roleText: 'Tenor' },
      { name: 'Francisco Pérez Sánchez', roleText: 'Piano' },
    ]);
    expect(facts.programText).toMatch(/Tosca/);
    expect(facts.programText).not.toMatch(/Miguel Borrallo/);
    expect(facts.works).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('Excelentia Año Nuevo: Director, Nombre no se come a la orquesta ni abre el programa', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-excelentia-ano-nuevo.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);

    expect(facts.venueText).toBe('Sala Sinfónica');
    expect(facts.performers).toEqual([
      { name: 'Orquesta Clásica Santa Cecilia' },
      { name: 'Kynan Johns', roleText: 'director' },
    ]);
    expect(facts.programText).toMatch(/Danubio azul/);
    expect(facts.works).toEqual([
      { title: 'Caballería ligera', composerName: 'F.v. Suppe' },
      { title: 'La caza, Polka, op.373', composerName: 'J. Strauss II' },
      { title: 'Las alegres comadres de Windsor, obertura', composerName: 'Otto Nicolai' },
      { title: 'El Danubio azul', composerName: 'J. Strauss' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'F.v. Suppe' },
      { name: 'J. Strauss II' },
      { name: 'Otto Nicolai' },
      { name: 'J. Strauss' },
    ]);
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
    expect(facts.works).toEqual([
      { title: 'Preludio, Fuga y Allegro, BWV998', composerName: 'J.S. Bach (1685 - 1750)' },
      { title: 'Theme and variations, op.77', composerName: 'Lennox Berkeley (1903 - 1989)' },
      {
        title: '"Lascia ch\'io pianga", de la opera Rinaldo',
        composerName: 'G.F. Händel (1685 - 1759)',
      },
      {
        title: 'Invocación y danza (Homenaje a Manuel de Falla)',
        composerName: 'Joaquín Rodrigo (1901 - 1999)',
      },
      { title: 'Un sueño en la floresta', composerName: 'Agustín Pío Barrios "Mangoré" (1885 - 1944)' },
      { title: 'La danza (tarantella napolitana)', composerName: 'Gioachino Rossini (1792 - 1866)' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'J.S. Bach (1685 - 1750)' },
      { name: 'Lennox Berkeley (1903 - 1989)' },
      { name: 'G.F. Händel (1685 - 1759)' },
      { name: 'Joaquín Rodrigo (1901 - 1999)' },
      { name: 'Agustín Pío Barrios "Mangoré" (1885 - 1944)' },
      { name: 'Gioachino Rossini (1792 - 1866)' },
    ]);
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
    expect(facts.composers).toEqual([
      { name: 'Honoré d’Ambruys (ca. 1660-ca. 1702)' },
      { name: 'Marc-Antoine Charpentier (1643-1704)' },
    ]);
    expect(facts.works).toEqual([
      {
        title: 'Le doux silence de nos bois, de Livre d’airs (1685)',
        composerName: 'Honoré d’Ambruys (ca. 1660-ca. 1702)',
      },
      {
        title: 'Celle qui fait tout mon tourment, H 450 (Recueil d’airs sérieux et à boire, 1695)',
        composerName: 'Marc-Antoine Charpentier (1643-1704)',
      },
      { title: 'Auprès du feu l’on fait l’amour, H 446', composerName: 'Marc-Antoine Charpentier (1643-1704)' },
      { title: 'Laissez durer la nuit', composerName: 'Marc-Antoine Charpentier (1643-1704)' },
    ]);
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

  it('entiende el programa Excelentia Composer · Work en un h4 de producción', () => {
    const html = `
      <article id="content">
        <h1>Excelentia. Concierto Piano Schumann y Beethoven Núm. 7</h1>
        <div class="content">
          <h4>Orquesta Clásica Santa Cecilia<br />Director: Sebastian Lang-Lessing ·<br />Zee Zee, piano<br />Elgar · In the South “Alassio”, op.50<br />Schumann · Concierto para piano y orquesta en la menor, op. 54<br />Beethoven · Sinfonía n.º 7</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location sinfonica rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `;
    const facts = parseAuditorioNacionalDetail(html);
    expect(facts.venueText).toBe('Sala Sinfónica');
    expect(facts.performers).toEqual([
      { name: 'Orquesta Clásica Santa Cecilia' },
      { name: 'Sebastian Lang-Lessing', roleText: 'director' },
      { name: 'Zee Zee', roleText: 'piano' },
    ]);
    expect(facts.works).toEqual([
      { title: 'In the South “Alassio”, op.50', composerName: 'Elgar' },
      {
        title: 'Concierto para piano y orquesta en la menor, op. 54',
        composerName: 'Schumann',
      },
      { title: 'Sinfonía n.º 7', composerName: 'Beethoven' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'Elgar' },
      { name: 'Schumann' },
      { name: 'Beethoven' },
    ]);
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

  function auditorioPage(title: string, blocks: string[]): string {
    const h4 = blocks.map((block) => `<h4>${block}</h4>`).join('\n');
    return `
      <article id="content">
        <h1>${title}</h1>
        <div class="content">${h4}</div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
  }

  function publishable(title: string, facts: ReturnType<typeof parseAuditorioNacionalDetail>) {
    return normalizeRawEvent({
      sourceId: 'auditorio-nacional',
      sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/x',
      observed: {
        title,
        occurrences: [{ raw: '2026-10-10T19:30:00+02:00' }],
        programText: facts.programText,
        venueText: facts.venueText,
        accessText: facts.accessText,
        performers: facts.performers ?? [],
        composers: facts.composers ?? [],
        works: facts.works ?? [],
      },
    });
  }

  it('Orquestra de Cambra Catalana es intérprete y nunca compositor', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('COMA’26. Orquestra de Cambra Catalana', [
        'Orquestra de Cambra Catalana<br />Stanislav Stepanek, concertino; Natàlia Borysiuk, concertino',
        'JAVIER MARTÍNEZ CAMPOS (1989) Kaerlud<br />ENRIQUE IGOA (1958) El sueño de Amadís Op. 45',
      ]),
    );
    expect(facts.performers?.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Orquestra de Cambra Catalana', 'Stanislav Stepanek', 'Natàlia Borysiuk']),
    );
    expect(facts.composers?.map((item) => item.name).join(' ')).not.toMatch(/orquestra/i);
    expect(facts.works?.some((work) => /orquestra/i.test(work.composerName ?? ''))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Kaerlud', composerName: 'JAVIER MARTÍNEZ CAMPOS (1989)' },
        { title: 'El sueño de Amadís Op. 45', composerName: 'ENRIQUE IGOA (1958)' },
      ]),
    );
  });

  it('no convierte el elenco en obras y sí separa NOMBRE (AÑO) obra', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('COMA’26. OSUCM', [
        'Orquesta Sinfónica de la Universidad Complutense de Madrid (OSUCM)<br />Katrina Penman, flauta; Gerardo López Laguna, piano<br />José Sanchís, director artístico y musical',
        'KATRINA PENMAN (1982) To Andalusia and beyond<br />JAVIER MARTÍNEZ CAMPOS (1989) Kaerlud<br />ALEJANDRO ROMÁN (1971) Tambourine op. 13<br />Variaciones para orquesta sobre un tema de Rameau (2001)',
      ]),
    );
    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Katrina Penman', roleText: 'flauta' },
        { name: 'Gerardo López Laguna', roleText: 'piano' },
        { name: 'José Sanchís', roleText: 'director artístico y musical' },
      ]),
    );
    expect(facts.works?.map((item) => item.title).join(' ')).not.toMatch(/Penman, flauta|López Laguna/i);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'To Andalusia and beyond', composerName: 'KATRINA PENMAN (1982)' },
        { title: 'Kaerlud', composerName: 'JAVIER MARTÍNEZ CAMPOS (1989)' },
      ]),
    );
    expect(facts.works?.some((work) => /rameau/i.test(work.composerName ?? ''))).toBe(false);
  });

  it('parte dos directores que comparten función', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('COMA’26. Nuevo Ensemble de Segovia', [
        'Nuevo Ensemble de Segovia<br />David Mata, violín y percusión; Elena de Santos Cámara, piano<br />Chema García Portela y Flores Chaviano, dirección',
      ]),
    );
    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'David Mata', roleText: 'violín y percusión' },
        { name: 'Elena de Santos Cámara', roleText: 'piano' },
        { name: 'Chema García Portela', roleText: 'dirección' },
        { name: 'Flores Chaviano', roleText: 'dirección' },
      ]),
    );
    expect(facts.works).toEqual([]);
  });

  it('Filarmonía Carmina Burana: Strauss y Orff por obra, sin I/II PARTE ni el solista como autor', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-filarmonia-carmina-burana.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const published = publishable('Filarmonía de Madrid. Carmina Burana', facts);
    const composerBlob = JSON.stringify(published?.composers);
    const workBlob = JSON.stringify(published?.works);

    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Orquesta y Coro Filarmonía' },
        { name: 'Matías Piñeira', roleText: 'Solista' },
        { name: 'Pascual Osa', roleText: 'Director' },
      ]),
    );
    expect(published?.works).toEqual([
      { title: 'Concierto para Trompa y Orquesta N.1', composerName: 'R. Strauss' },
      { title: 'Carmina Burana', composerName: 'C. Orff' },
    ]);
    expect(matchComposer('R. Strauss')?.canonicalName).toBe('Richard Strauss');
    expect(matchComposer('C. Orff')?.canonicalName).toBe('Carl Orff');
    expect(published?.composers?.map((item) => matchComposer(item.name)?.canonicalName)).toEqual([
      'Richard Strauss',
      'Carl Orff',
    ]);
    expect(composerBlob).not.toMatch(/I PARTE|II PARTE|Piñeira|Solista/i);
    expect(workBlob).not.toMatch(/I PARTE|II PARTE|Piñeira|Solista/i);
    expect(facts.programText).not.toMatch(/Matías Piñeira|Orquesta y Coro Filarmonía/i);
  });

  it('Viena en Madrid: atribuciones por obra, sin heredar Suppé ni inventar un Strauss', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-filarmonia-viena-en-madrid.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const published = publishable('Filarmonía de Madrid. Viena en Madrid', facts);
    const composerNames = published?.composers?.map((item) => item.name) ?? [];
    const pique = published?.works?.find((work) => /pique dame/i.test(work.title));
    const helene = published?.works?.find((work) => /belle hélène/i.test(work.title));
    const freikugeln = published?.works?.find((work) => /freikugeln/i.test(work.title));
    const lehár = published?.works?.find((work) => /nechledil/i.test(work.title));

    expect(composerNames.some((name) => /compa[ñn][ií]a|jac ballet/i.test(name))).toBe(false);
    expect(composerNames.some((name) => /pique dame/i.test(name))).toBe(false);
    expect(pique).toEqual({ title: 'Pique Dame', composerName: 'F. V. Suppé' });
    expect(helene).toEqual({ title: 'La Belle Hélène', composerName: 'J. Offenbach' });
    expect(freikugeln).toMatchObject({ title: expect.stringMatching(/Freikugeln/i) });
    expect(freikugeln?.composerName).toBeUndefined();
    expect(lehár?.composerName).toMatch(/Lehár/i);
    expect(published?.works?.filter((work) => /suppé|suppe/i.test(work.composerName ?? ''))).toEqual([
      { title: 'Pique Dame', composerName: 'F. V. Suppé' },
    ]);
    expect(composerNames.some((name) => /^j\.?\s*strauss$/i.test(name))).toBe(false);
    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Orquesta Filarmonía' },
        { name: 'Compañía JAC Ballet' },
        { name: 'Jose Antonio Checa', roleText: 'Coreógrafo' },
        { name: 'Pascual Osa', roleText: 'Director Artístico' },
      ]),
    );
  });

  it('Savall / Brahms: un compositor, dos obras, sin Capella ni créditos ni catálogo suelto', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-savall-brahms.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const published = publishable('Jordi Savall Dirige a Johannes Brahms', facts);
    const composerNames = published?.composers?.map((item) => item.name) ?? [];
    const titles = published?.works?.map((work) => work.title) ?? [];

    expect(composerNames).toHaveLength(1);
    expect(composerNames[0]).toMatch(/Johannes Brahms/i);
    expect(published?.works).toHaveLength(2);
    expect(titles[0]).toMatch(/Schicksalslied/i);
    expect(titles[0]).toMatch(/op\.?\s*54/i);
    expect(titles[1]).toMatch(/Ein deutsches Requiem/i);
    expect(titles[1]).toMatch(/op\.?\s*45/i);
    expect(published?.works?.every((work) => /Brahms/i.test(work.composerName ?? ''))).toBe(true);
    expect(composerNames.some((name) => /capella|vilamajó|hölderlin/i.test(name))).toBe(false);
    expect(titles.some((title) => /^op\.?\s*\d+/i.test(title))).toBe(false);
    expect(titles.some((title) => /capella|vilamajó|hölderlin|texto:/i.test(title))).toBe(false);
    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Lina Tur Bonet', roleText: 'concertino' },
        { name: 'Luca Guglielmi', roleText: 'asistente de dirección' },
        { name: 'LA CAPELLA NACIONAL DE CATALUNYA' },
        { name: 'Lluís Vilamajó', roleText: 'preparación del conjunto vocal' },
        { name: 'Jordi Savall', roleText: 'dirección' },
      ]),
    );
  });

  it('Madama Butterfly: Puccini y la ópera, sin Adaptación Escenificada como obra', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-madama-butterfly.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const published = publishable('Camerata Lírica. Ópera Madama Butterfly de G. Puccini', facts);

    expect(published?.works).toHaveLength(1);
    expect(published?.works?.[0]?.title).toMatch(/Madama Butterfly/i);
    expect(published?.works?.[0]?.composerName).toMatch(/G\.\s*Puccini/i);
    expect(matchComposer(published?.works?.[0]?.composerName ?? '')?.canonicalName).toBe('Giacomo Puccini');
    expect(published?.composers).toHaveLength(1);
    expect(JSON.stringify(published?.works)).not.toMatch(/Adaptaci[oó]n Escenificada/i);
    expect(facts.performers?.map((item) => item.name)).toEqual(
      expect.arrayContaining(['CAMERATA LÍRICA', 'Sergio Kuhlmann']),
    );
    expect(facts.performers?.some((item) => /musical y piano/i.test(item.name))).toBe(false);
    expect(facts.performers?.find((item) => item.name === 'Sergio Kuhlmann')?.roleText).toMatch(
      /director musical y piano/i,
    );
  });

  it('acepta un compositor contemporáneo desconocido con sintaxis de nombre personal', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('Ciclo contemporáneo', [
        'Ensemble Horizonte<br />Marina Vespertilio (1991)<br />Nocturno de los tilos, op. 8',
      ]),
    );
    expect(facts.composers).toEqual([{ name: 'Marina Vespertilio (1991)' }]);
    expect(facts.works).toEqual([
      { title: 'Nocturno de los tilos, op. 8', composerName: 'Marina Vespertilio (1991)' },
    ]);
    expect(matchComposer('Marina Vespertilio')).toBeUndefined();
  });

  it('agrupa varias obras bajo un mismo encabezado válido', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('Mahler vocal y sinfónico', [
        'Gustav Mahler (1860-1911)<br />Lieder eines fahrenden Gesellen<br />Sinfonía núm. 1 en Re mayor',
      ]),
    );
    expect(facts.composers).toEqual([{ name: 'Gustav Mahler (1860-1911)' }]);
    expect(facts.works).toEqual([
      { title: 'Lieder eines fahrenden Gesellen', composerName: 'Gustav Mahler (1860-1911)' },
      { title: 'Sinfonía núm. 1 en Re mayor', composerName: 'Gustav Mahler (1860-1911)' },
    ]);
  });

  it('un movimiento IX no se publica como compositor ni como obra', () => {
    const facts = parseAuditorioNacionalDetail(
      auditorioPage('Sinfonía con movimientos', [
        'Anton Bruckner (1824-1896)<br />Sinfonía núm. 8<br />IX. Adagio',
      ]),
    );
    expect(facts.composers).toEqual([{ name: 'Anton Bruckner (1824-1896)' }]);
    expect(facts.works).toEqual([
      { title: 'Sinfonía núm. 8', composerName: 'Anton Bruckner (1824-1896)' },
    ]);
    expect(facts.works?.some((work) => /^IX\./i.test(work.title))).toBe(false);
    expect(facts.composers?.some((item) => /^IX\./i.test(item.name))).toBe(false);
  });

  it('Sinfónico 11: Schwanendreher es obra, no viola-persona, y el elenco inequívoco se conserva', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-ocne-sinfonico-11.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(expect.arrayContaining(['Orquesta Nacional de España', 'Kristiina Poska', 'Tabea Zimmermann']));
    expect(names.some((name) => /schwanendreher|hindemith|mendelssohn|escocesa/i.test(name))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Der Schwanendreher, para viola y pequeña orquesta', composerName: 'Paul Hindemith' },
      ]),
    );
  });

  it('Pájaro de fuego: Composer, Title no se publica como intérprete', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-filarmonica-pajaro-fuego.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['Orquesta Joven de Colombia', 'Nelson Goerner', 'Andrés Orozco-Estrada']),
    );
    expect(names.some((name) => /stravinsky|p[aá]jaro de fuego|rachm[aá]ninov/i.test(name))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Concierto para piano núm. 2', composerName: 'Rachmáninov' },
        { title: 'El pájaro de fuego (música del ballet completo)', composerName: 'Stravinsky' },
      ]),
    );
  });

  it('América 250: un segundo h4 de programa no convierte el cuarteto en elenco', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-america-250.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['Aulos Madrid', 'Álvaro Octavio Díaz', 'José María Ferrero', 'Javier Bonet']),
    );
    expect(names.some((name) => /americano|quinteto de viento|dvo[rř]ák|carter/i.test(name))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Cuarteto «Americano», op. 96 (arr. David Walter)', composerName: 'Antonín Dvořák' },
      ]),
    );
  });

  it('Vientos de Palacio: cuarteto sobre Una cosa rara es obra, el elenco con rol se conserva', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-vientos.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['Camerata Federici', 'Mario Pérez', 'Irene Val', 'Javier Bonet']),
    );
    expect(names.some((name) => /cosa rara|cuarteto para oboe|sexteto/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Una cosa rara/);
  });

  it('Maderas de Color: cuarteto para corno inglés partido no es performer', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-maderas.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(expect.arrayContaining(['Quima Ensemble', 'Elsa Sánchez', 'Marta Santamaría']));
    expect(names.some((name) => /corno ingl[eé]s|françaix|schubert/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Cuarteto para corno inglés/);
  });

  it('Ven con Beethoven: Dona nobis a capella es programa; los nombres con rol se conservan', async () => {
    const html = await readFile(
      path.join(detailDir, 'auditorio-ocne-satelite-beethoven.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['Delia Agúndez', 'Ariadna Martínez', 'Patricia Glez. Arroyo', 'Daniel Oyarzabal']),
    );
    expect(names.some((name) => /dona nobis|c[aá]nones|beethoven|inn o al creatore/i.test(name))).toBe(false);
    expect(facts.programText).toMatch(/Dona nobis pacem/);
  });

  it('UAM Quinteto: el quinteto de clarinete no desplaza al ensemble homónimo', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-uam-quinteto-berlin.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['QUINTETO DE LA FILARMÓNICA DE BERLÍN', 'Wolfgang Talirz', 'Miguel Ángel Tamarit']),
    );
    expect(names.some((name) => /quinteto para clarinete|op\. 34/i.test(name))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Quinteto para clarinete, op. 34', composerName: 'Carl Maria von Weber (1782-1826)' },
      ]),
    );
  });

  it('Excelentia Respighi: Composer.- Work no es performer ni compositor sticky', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-excelentia-respighi.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(facts.performers).toEqual([
      { name: 'Orquesta Clásica Santa Cecilia' },
      { name: 'Christian Vasquez', roleText: 'director' },
    ]);
    expect(names.some((name) => /respighi|pinos de roma|strauss|beethoven/i.test(name))).toBe(false);
    expect(facts.works).toEqual([
      { title: 'Don Juan, poema sinfónico', composerName: 'R.Strauss' },
      { title: 'Pinos de Roma', composerName: 'Respighi' },
      { title: 'Sinfonía núm 5', composerName: 'Beethoven' },
    ]);
    expect(facts.composers?.some((item) => /pinos de roma/i.test(item.name))).toBe(false);
  });

  it('UPM América: recupera solistas tras (compositor) y no publica la obra como nombre', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-upm-america.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(
      expect.arrayContaining(['ORQUESTA SINFÓNICA UPM', 'Marcos Enrique Romero Gil', 'Susana Gómez Vázquez', 'Javier Sanz Pascual']),
    );
    expect(facts.performers).toEqual(
      expect.arrayContaining([
        { name: 'Susana Gómez Vázquez', roleText: 'piano' },
        { name: 'Javier Sanz Pascual', roleText: 'fagot' },
      ]),
    );
    expect(names.some((name) => /rhapsody in blue|ciranda das sete|gershwin|villa-lobos/i.test(name))).toBe(
      false,
    );
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Rhapsody in Blue', composerName: 'G. Gershwin' },
        { title: 'Ciranda das Sete Notas', composerName: 'H. Villa-Lobos' },
      ]),
    );
    expect(facts.programText).toMatch(/Rhapsody in Blue/);
  });

  it('Amor Brujo: VIII.Nana no es compositor sticky de los movimientos siguientes', async () => {
    const html = await readFile(path.join(detailDir, 'auditorio-amor-brujo.excerpt.html'), 'utf8');
    const facts = parseAuditorioNacionalDetail(html);
    const composerNames = facts.composers?.map((item) => item.name) ?? [];
    const names = facts.performers?.map((item) => item.name) ?? [];

    expect(names).toEqual(expect.arrayContaining(['Atlántida Chamber Orchestra', 'Manuel Tévar']));
    expect(composerNames.some((name) => /nana de sevilla|pelegrinitos|reyes de la baraja/i.test(name))).toBe(
      false,
    );
    expect(facts.works?.some((work) => /nana de sevilla/i.test(work.composerName ?? ''))).toBe(false);
    expect(facts.works).toEqual(
      expect.arrayContaining([
        { title: 'Canciones españolas antiguas', composerName: 'FEDERICO GARCÍA LORCA (1898–1936)' },
        { title: 'El amor brujo (versión 1914)', composerName: 'MANUEL DE FALLA (1876–1946)' },
      ]),
    );
    expect(facts.works?.some((work) => /^VIII\./i.test(work.title) || /^IX\./i.test(work.title))).toBe(false);
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

  it('extrae Equipo Artístico musical, reparto y el compositor declarado como Música de', () => {
    const html = `
      <div class="wrap-content-hero">
        <h4>Ópera</h4>
        <h1>Manon Lescaut</h1>
      </div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free collapsible-mobile">
          <p>Manon Lescaut, la tercera ópera de Giacomo Puccini, llega al Real.</p>
          <hr />
          <p><em>Dramma lirico</em> en cuatro actos.</p>
          <p><strong>Música</strong> de Giacomo Puccini (1858-1924).</p>
          <p><strong>Libreto</strong> de Domenico Oliva y Luigi Illica.</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <h3 class="titulo-artistas">Equipo Artístico</h3>
      <ul class="lista-artistas">
        <li class="lista-artistas">
          <span class="lista-artistas-text">Dirección musical</span>
          <span class="lista-artistas-title">Nicola Luisotti</span>
        </li>
        <li class="lista-artistas">
          <span class="lista-artistas-text">Dirección de escena</span>
          <span class="lista-artistas-title">Carlos Wagner</span>
        </li>
        <li class="lista-artistas">
          <span class="lista-artistas-text">Vestuario</span>
          <span class="lista-artistas-title">Jon Morrell</span>
        </li>
        <li class="lista-artistas">
          <span class="lista-artistas-text">Dirección del coro</span>
          <span class="lista-artistas-title">José Luis Basso</span>
        </li>
        <li class="lista-artistas">
          <span class="lista-artistas-text">Coro y Orquesta</span>
          <span class="lista-artistas-title">Coro y Orquesta Titulares del Teatro Real</span>
        </li>
      </ul>
      <section class="page-thumb-artist page-thumb-artist-img">
        <h3>Reparto</h3>
        <div class="page-thumb-artist__block">
          <p><span class="position">Manon Lescaut</span> <span class="title">Sondra Radvanovsky</span></p>
        </div>
        <div class="page-thumb-artist__block">
          <p><span class="position">El caballero Renato des Grieux</span> <span class="title">Michael Fabiano</span></p>
        </div>
        <div class="page-thumb-artist__block">
          <p><span class="position">Dirección de escena</span> <span class="title">Carlos Wagner</span></p>
        </div>
        <div class="page-thumb-artist__block">
          <p><span class="position">Dirección musical</span> <span class="title">Nicola Luisotti</span></p>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Sala Principal</p></div>
      </section>
    `;
    const facts = parseTeatroRealDetail(html);
    expect(facts.categoryText).toBe('Ópera');
    expect(facts.venueText).toBe('Sala Principal');
    expect(facts.composers).toEqual([{ name: 'Giacomo Puccini' }]);
    expect(facts.performers).toEqual([
      { name: 'Nicola Luisotti', roleText: 'director' },
      { name: 'José Luis Basso', roleText: 'director' },
      { name: 'Coro y Orquesta Titulares del Teatro Real', roleText: 'Coro y Orquesta' },
      { name: 'Sondra Radvanovsky', roleText: 'Manon Lescaut' },
      { name: 'Michael Fabiano', roleText: 'El caballero Renato des Grieux' },
    ]);
    expect(facts.performers?.map((item) => item.name)).not.toContain('Carlos Wagner');
    expect(facts.performers?.map((item) => item.name)).not.toContain('Jon Morrell');
    expect(facts.works).toEqual([]);
  });

  it('limpia años y el punto final de Música de Vincenzo Bellini (1801-1835).', () => {
    const facts = parseTeatroRealDetail(`
      <div class="wrap-content-hero"><h4>Ópera</h4><h1>Norma</h1></div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p><strong>Música</strong> de Vincenzo Bellini (1801-1835).</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Sala Principal</p></div>
      </section>
    `);
    expect(facts.composers).toEqual([{ name: 'Vincenzo Bellini' }]);
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

  it('conserva Sala Pacífico y Sala Principal del Retiro cuando la ficha las nombra', () => {
    const pacifico = parseTeatroRealDetail(`
      <div class="wrap-content-hero"><h4>El Real Junior</h4><h1>¿Te suena Tannhäuser, de R. Wagner?</h1></div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p>Taller musical en familia.</p>
          <p><strong>SALA PACÍFICO</strong> Real Teatro de Retiro, Plaza Daoíz y Velarde, 4. Metro Pacífico</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Real Teatro de Retiro</p></div>
      </section>
    `);
    expect(pacifico.venueText).toBe('Sala Pacífico Real Teatro de Retiro');

    const principal = parseTeatroRealDetail(`
      <div class="wrap-content-hero"><h4>El Real Junior</h4><h1>Las bodas de Fígaro, de W.A Mozart</h1></div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p>Ópera para niños y jóvenes.</p>
          <p>SALA PRINCIPAL Real Teatro de Retiro, Plaza Daoíz y Velarde, 4. Metro Pacífico</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Real Teatro de Retiro</p></div>
      </section>
    `);
    expect(principal.venueText).toBe('Sala Principal Real Teatro de Retiro');
  });

  it('sigue leyendo Sala Principal del coliseo cuando no hay frase de Retiro', () => {
    const facts = parseTeatroRealDetail(`
      <div class="wrap-content-hero"><h4>Ópera</h4><h1>Tannhäuser</h1></div>
      <div class="back-image"></div>
      <section class="text-intro-show">
        <div class="wrap-text-free">
          <p>Ópera de Richard Wagner.</p>
          <div class="text-collapsible-cover"></div>
        </div>
      </section>
      <section class="functions-show">
        <div class="functions-show__block--item-space"><p>Sala Principal</p></div>
      </section>
    `);
    expect(facts.venueText).toBe('Sala Principal');
  });

  it('falla si el HTML no es una ficha reconocible', () => {
    expect(() => parseTeatroRealDetail('<div class="home">Teatro Real</div>')).toThrow(/estructura esperada/);
  });
});

describe('parser de ficha Madrid Datos', () => {
  it('extrae descripción ampliada, intérpretes y compositores del excerpt renacentista', async () => {
    const html = await readFile(path.join(detailDir, 'madrid-datos-renacentista.excerpt.html'), 'utf8');
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toMatch(/cuerda pulsada/);
    expect(facts.programText).toMatch(/Luis de Milán/);
    expect(facts.performers).toEqual([
      { name: 'Jesús Hernández' },
      { name: 'Santiago Pindado' },
    ]);
    expect(facts.composers).toEqual([
      { name: 'Luis de Milán' },
      { name: 'Luys de Narváez' },
      { name: 'Alonso Mudarra' },
      { name: 'Enríquez de Valderrábano' },
    ]);
    expect(facts.works).toEqual([]);
    expect(facts.occurrences).toBeUndefined();
    expect(facts.venueText).toBeUndefined();
    expect(facts.accessText).toBeUndefined();
  });

  it('extrae el dúo de RAGE y conserva el texto contemporáneo', async () => {
    const html = await readFile(path.join(detailDir, 'madrid-datos-rage.excerpt.html'), 'utf8');
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toMatch(/técnicas extendidas/);
    expect(facts.programText).toMatch(/estreno absoluto/);
    expect(facts.performers).toEqual([{ name: 'Weston Olencki' }, { name: 'Mattie Barbier' }]);
    expect(facts.composers).toEqual([]);
  });

  it('conserva la evidencia editorial de Lê Quan Ninh sin inventar el elenco', async () => {
    const html = await readFile(path.join(detailDir, 'madrid-datos-ninh.excerpt.html'), 'utf8');
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toMatch(/formación clásica/);
    expect(facts.programText).toMatch(/música contemporánea/);
    expect(facts.performers).toEqual([]);
    expect(facts.composers).toEqual([]);
  });

  it('extrae el dúo de Senyawa cuando el texto lo declara', async () => {
    const html = await readFile(path.join(detailDir, 'madrid-datos-senyawa.excerpt.html'), 'utf8');
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toMatch(/improvisación/);
    expect(facts.performers).toEqual([{ name: 'Rully Shabara' }, { name: 'Wukir Suryadi' }]);
  });

  it('una ficha sin información musical adicional deja el patch vacío', async () => {
    const html = await readFile(path.join(detailDir, 'madrid-datos-piano.excerpt.html'), 'utf8');
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toBeUndefined();
    expect(facts.programText).toBeUndefined();
    expect(facts.performers).toEqual([]);
    expect(facts.composers).toEqual([]);
    expect(facts.works).toEqual([]);
  });

  it('lee .detalle / .tiny-text de producción y no copia fecha, lugar ni acceso', () => {
    const html = `
      <main class="mainContent" id="readspeaker">
        <div class="detalle">
          <div class="summary"><h3 class="summary-title">Concierto de m&uacute;sica renacentista</h3></div>
          <div class="tramites-content">
            <div class="image-content"></div>
            <div class="tiny-text">
              <p>A cargo de <strong>Jes&uacute;s Hern&aacute;ndez</strong> y <strong>Santiago Pindado</strong>, el concierto ser&aacute; interpretado con instrumentos de cuerda pulsada.</p>
              <p>El repertorio propuesto incluye obras maestras de autores tan relevantes como Luis de Mil&aacute;n, Luys de Narv&aacute;ez, Alonso Mudarra y Enr&iacute;quez de Valderr&aacute;bano, cuyas composiciones representan un pilar cultural.</p>
            </div>
          </div>
          <div class="info-actividad">
            <h4 class="fecha title9">Fecha</h4>
            <p class="text-date">Viernes 16 de octubre de 2026 a las 18:30 horas</p>
            <h4 class="place title9">Lugar de celebraci&oacute;n</h4>
            <dd><a class="url fn">Biblioteca P&uacute;blica Municipal Miguel Delibes (Moratalaz)</a></dd>
            <p class="gratuita">Gratuito</p>
            <h5>Organizaci&oacute;n</h5>
            <p>Bibliotecas Madrid</p>
          </div>
        </div>
      </main>
    `;
    const facts = parseMadridDatosDetail(html);
    expect(facts.description).toMatch(/cuerda pulsada/);
    expect(facts.performers?.map((item) => item.name)).toEqual(['Jesús Hernández', 'Santiago Pindado']);
    expect(facts.composers?.map((item) => item.name)).toContain('Luis de Milán');
    expect(facts.organizerText).toBe('Bibliotecas Madrid');
    expect(facts.occurrences).toBeUndefined();
    expect(facts.venueText).toBeUndefined();
    expect(facts.accessText).toBeUndefined();
    expect(facts.eventStatus).toBeUndefined();
  });

  it('un markup parcialmente distinto (sin .detalle, con tramites-content) no rompe', () => {
    const html = `
      <div class="tramites-content wrapping">
        <div class="tiny-text">
          <p class="jumbotron"><a>VANG VIII. M&uacute;sicas en vanguardia</a></p>
          <p>El d&uacute;o formado por Weston Olencki y Mattie Barbier presenta un estreno.</p>
        </div>
      </div>
    `;
    const facts = parseMadridDatosDetail(html);
    expect(facts.seriesText).toMatch(/VANG VIII/);
    expect(facts.performers).toEqual([{ name: 'Weston Olencki' }, { name: 'Mattie Barbier' }]);
    expect(facts.description).toMatch(/estreno/);
  });

  it('no mezcla el ciclo del jumbotron con los intérpretes de un dúo', () => {
    const html = `
      <article>
        <h1>Senyawa</h1>
        <p>Limo . Músicas corrientes</p>
        <p>Rully Shabara y Wukir Suryadi son un dúo indonesio procedente de Java.</p>
      </article>
    `;
    const facts = parseMadridDatosDetail(html);
    expect(facts.performers).toEqual([{ name: 'Rully Shabara' }, { name: 'Wukir Suryadi' }]);
  });

  it('falla si el HTML no es una ficha reconocible', () => {
    expect(() => parseMadridDatosDetail('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>')).toThrow(
      /estructura esperada/,
    );
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
