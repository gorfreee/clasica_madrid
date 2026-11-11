import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeComposerList,
  canonicalizeComposerName,
  canonicalizeWorkList,
} from '../src/ingestion/composer-name.ts';
import {
  applyPublishedComposerCanonicalization,
  auditAfterCanonicalization,
  auditPublishedComposers,
  canonicalizePublishedComposerFields,
  composerFieldsChanged,
  replacePublishedComposerFields,
} from '../src/ingestion/published-composers.ts';
import { findComposerIdentityIssues } from '../src/lib/validation/composer-identity.ts';
import { validateRawFiles } from '../src/lib/validation/validate-dir.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { Catalog } from '../src/lib/domain/catalog.ts';
import type { RawEntityFile } from '../src/lib/repository/fs.ts';
import { makeCatalog, makeEvent } from './helpers.ts';

function filesFromCatalog(catalog: Catalog): RawEntityFile[] {
  const files: RawEntityFile[] = [];
  const map = {
    events: catalog.events,
    venues: catalog.venues,
    organizers: catalog.organizers,
    series: catalog.series,
    sources: catalog.sources,
  } as const;
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of map[collection]) {
      const filename = `${entity.id}.json`;
      files.push({
        collection,
        filename,
        relativePath: `${collection}/${filename}`,
        absolutePath: `/virtual/${collection}/${filename}`,
        raw: JSON.stringify(entity),
      });
    }
  }
  return files;
}

const DIRTY_EVENT = makeEvent({
  composers: [
    { name: 'Bach' },
    { name: 'J. S. Bach' },
    { name: 'Johann Sebastian Bach (1685-1750)' },
    { name: 'Varios autores' },
    { name: 'Anónimo (s. XVII)' },
    { name: 'Tradicional de Venezuela' },
    { name: 'JAVIER MARTÍNEZ CAMPOS' },
    { name: 'Marina Vespertilio' },
  ],
  works: [
    { title: 'El clave bien temperado', composerName: 'Johann Sebastian Bach (1685-1750)' },
    { title: 'Danza', composerName: 'Tradicional de Venezuela' },
    { title: 'Canción anónima', composerName: 'Anónimo (s. XVII)' },
    { title: 'Sinfonía n.º 7', composerName: 'Beethoven' },
    { title: 'Estudio', composerName: 'Marina Vespertilio' },
    { title: 'MANUEL DE FALLA (1876–1946) no es un título tocado', composerName: 'Manuel de Falla (1876-1946)' },
  ],
});

describe('canonicalización de aliases, lifespan, ALL CAPS y pseudo-compositores', () => {
  it('converge aliases de Bach y Beethoven al canonicalName', () => {
    expect(canonicalizeComposerName('Bach')).toBe('Johann Sebastian Bach');
    expect(canonicalizeComposerName('J. S. Bach')).toBe('Johann Sebastian Bach');
    expect(canonicalizeComposerName('Beethoven')).toBe('Ludwig van Beethoven');
    expect(canonicalizeComposerName('L. van Beethoven')).toBe('Ludwig van Beethoven');
  });

  it('quita lifespan biográfico final', () => {
    expect(canonicalizeComposerName('Manuel de Falla (1876-1946)')).toBe('Manuel de Falla');
    expect(canonicalizeComposerName('Philip Glass (1937)')).toBe('Philip Glass');
    expect(canonicalizeComposerName('Krzysztof Penderecki (1933-2020)')).toBe('Krzysztof Penderecki');
  });

  it('omite pseudo-compositores inequívocos', () => {
    expect(canonicalizeComposerName('Varios autores')).toBeUndefined();
    expect(canonicalizeComposerName('Anónimo (s. XVII)')).toBeUndefined();
    expect(canonicalizeComposerName('Tradicional de Venezuela')).toBeUndefined();
  });

  it('corrige ALL CAPS con la función conservadora y el canonicalName si es conocido', () => {
    expect(canonicalizeComposerName('JAVIER MARTÍNEZ CAMPOS')).toBe('Javier Martínez Campos');
    expect(canonicalizeComposerName('MANUEL DE FALLA (1876–1946)')).toBe('Manuel de Falla');
  });

  it('deduplica después de canonicalizar preservando el primer orden', () => {
    expect(
      canonicalizeComposerList([
        { name: 'Bach' },
        { name: 'Mozart' },
        { name: 'J. S. Bach' },
        { name: 'Johann Sebastian Bach (1685-1750)' },
      ]),
    ).toEqual([{ name: 'Johann Sebastian Bach' }, { name: 'Wolfgang Amadeus Mozart' }]);
  });

  it('no altera work.title al canonicalizar composerName', () => {
    const title = 'MANUEL DE FALLA (1876–1946) no es un título tocado';
    expect(
      canonicalizeWorkList([
        { title, composerName: 'Manuel de Falla (1876-1946)' },
        { title: 'Danza', composerName: 'Tradicional de Venezuela' },
      ]),
    ).toEqual([{ title, composerName: 'Manuel de Falla' }, { title: 'Danza' }]);
  });
});

describe('idempotencia', () => {
  it('canonicalizar dos veces un evento sucio no produce más cambios', () => {
    const once = { ...DIRTY_EVENT, ...canonicalizePublishedComposerFields(DIRTY_EVENT) };
    expect(composerFieldsChanged(DIRTY_EVENT, once)).toBe(true);
    const twice = canonicalizePublishedComposerFields(once);
    expect(composerFieldsChanged(once, twice)).toBe(false);
    expect(twice).toEqual({ composers: once.composers, works: once.works });
  });

  it('la migración sobre un árbol ya limpio escribe cero archivos', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composers-clean-'));
    await mkdir(path.join(root, 'events'));
    const event = makeEvent({
      composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Marina Vespertilio' }],
      works: [
        { title: 'Preludio', composerName: 'Johann Sebastian Bach' },
        { title: 'Estudio', composerName: 'Marina Vespertilio' },
      ],
    });
    const raw = `${JSON.stringify(event, null, 2)}\n`;
    await writeFile(path.join(root, 'events', `${event.id}.json`), raw);
    const first = await applyPublishedComposerCanonicalization(root);
    expect(first.filesWritten).toEqual([]);
    const second = await applyPublishedComposerCanonicalization(root);
    expect(second.filesWritten).toEqual([]);
    expect(await readFile(path.join(root, 'events', `${event.id}.json`), 'utf8')).toBe(raw);
  });

  it('aplicar la migración dos veces sobre un evento sucio deja el fichero quieto la segunda', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composers-dirty-'));
    await mkdir(path.join(root, 'events'));
    const raw = `${JSON.stringify(DIRTY_EVENT, null, 2)}\n`;
    const file = path.join(root, 'events', `${DIRTY_EVENT.id}.json`);
    await writeFile(file, raw);
    const first = await applyPublishedComposerCanonicalization(root);
    expect(first.filesWritten).toEqual([`events/${DIRTY_EVENT.id}.json`]);
    const afterFirst = await readFile(file, 'utf8');
    const second = await applyPublishedComposerCanonicalization(root);
    expect(second.filesWritten).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(afterFirst);
    const parsed = JSON.parse(afterFirst) as typeof DIRTY_EVENT;
    expect(parsed.id).toBe(DIRTY_EVENT.id);
    expect(parsed.slug).toBe(DIRTY_EVENT.slug);
    expect(parsed.title).toBe(DIRTY_EVENT.title);
    expect(parsed.composers).toEqual([
      { name: 'Johann Sebastian Bach' },
      { name: 'Javier Martínez Campos' },
      { name: 'Marina Vespertilio' },
    ]);
    expect(parsed.works[0]?.title).toBe('El clave bien temperado');
    expect(parsed.works[5]?.title).toBe('MANUEL DE FALLA (1876–1946) no es un título tocado');
    expect(parsed.works[5]?.composerName).toBe('Manuel de Falla');
  });
});

describe('reescritura quirúrgica de JSON', () => {
  it('replacePublishedComposerFields no toca título, works[].title ni otros campos', () => {
    const raw = `${JSON.stringify(DIRTY_EVENT, null, 2)}\n`;
    const next = canonicalizePublishedComposerFields(DIRTY_EVENT);
    const rewritten = replacePublishedComposerFields(raw, next.composers, next.works);
    const after = JSON.parse(rewritten) as typeof DIRTY_EVENT;
    expect(after.title).toBe(DIRTY_EVENT.title);
    expect(after.id).toBe(DIRTY_EVENT.id);
    expect(after.slug).toBe(DIRTY_EVENT.slug);
    expect(after.status).toBe(DIRTY_EVENT.status);
    expect(after.occurrences).toEqual(DIRTY_EVENT.occurrences);
    expect(after.performers).toEqual(DIRTY_EVENT.performers);
    expect(after.eras).toEqual(DIRTY_EVENT.eras);
    expect(after.formats).toEqual(DIRTY_EVENT.formats);
    expect(after.citations).toEqual(DIRTY_EVENT.citations);
    expect(after.primarySourceId).toBe(DIRTY_EVENT.primarySourceId);
    expect(after.lastVerifiedAt).toBe(DIRTY_EVENT.lastVerifiedAt);
    expect(after.works.map((item) => item.title)).toEqual(DIRTY_EVENT.works.map((item) => item.title));
    expect(rewritten).toContain(`"title": ${JSON.stringify(DIRTY_EVENT.title)}`);
  });
});

describe('auditoría', () => {
  it('cuenta aliases, lifespan, pseudo, ALL CAPS, duplicados y desconocidos', () => {
    const audit = auditPublishedComposers([DIRTY_EVENT]);
    expect(audit.eventsExamined).toBe(1);
    expect(audit.eventsWithComposers).toBe(1);
    expect(audit.aliases.some((item) => item.value === 'Bach' && item.extra === 'Johann Sebastian Bach')).toBe(
      true,
    );
    expect(audit.withLifespan.some((item) => item.value === 'Philip Glass (1937)')).toBe(false);
    expect(
      audit.withLifespan.some((item) => item.value === 'Johann Sebastian Bach (1685-1750)'),
    ).toBe(true);
    expect(audit.pseudo.map((item) => item.value).sort()).toEqual(
      ['Anónimo (s. XVII)', 'Tradicional de Venezuela', 'Varios autores'].sort(),
    );
    expect(audit.allCaps.some((item) => item.value === 'JAVIER MARTÍNEZ CAMPOS')).toBe(true);
    expect(audit.duplicates).toEqual([
      expect.objectContaining({
        eventId: DIRTY_EVENT.id,
        canonical: 'Johann Sebastian Bach',
      }),
    ]);
    expect(audit.unknownPersons.some((item) => item.value === 'Marina Vespertilio')).toBe(true);
    expect(audit.unknownPersons.some((item) => item.value === 'Javier Martínez Campos')).toBe(true);
    const after = auditAfterCanonicalization([DIRTY_EVENT]);
    expect(after.eventsChanged).toBe(0);
    expect(after.mentionsRewritten).toBe(0);
    expect(after.aliases).toEqual([]);
    expect(after.withLifespan).toEqual([]);
    expect(after.pseudo).toEqual([]);
    expect(after.duplicates).toEqual([]);
    expect(after.allCaps).toEqual([]);
  });

  it('no inventa correcciones para un paréntesis no biográfico', () => {
    const event = makeEvent({
      composers: [{ name: 'Marina Vespertilio (edición crítica)' }],
      works: [{ title: 'Estudio', composerName: 'Marina Vespertilio (edición crítica)' }],
    });
    const audit = auditPublishedComposers([event]);
    expect(audit.eventsChanged).toBe(0);
    expect(audit.suspicious.some((item) => item.value === 'Marina Vespertilio (edición crítica)')).toBe(
      true,
    );
    expect(canonicalizePublishedComposerFields(event).composers).toEqual(event.composers);
  });

  it('reporta HTML residual y listas de personas sin reescribirlas', () => {
    const event = makeEvent({
      composers: [
        { name: 'Francis Poulenc/strong>' },
        { name: 'Benjamin Britten , Henry Purcell , John Dowland' },
      ],
    });
    const audit = auditPublishedComposers([event]);
    expect(audit.eventsChanged).toBe(0);
    expect(audit.suspicious.map((item) => item.value).sort()).toEqual([
      'Benjamin Britten , Henry Purcell , John Dowland',
      'Francis Poulenc/strong>',
    ]);
  });
});

describe('guardrail del catálogo', () => {
  it('falla un catálogo sucio con event.id, valor y esperado', () => {
    const catalog = makeCatalog({ events: [DIRTY_EVENT] });
    const issues = findComposerIdentityIssues(catalog);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.code === 'composer-identity')).toBe(true);
    expect(issues.every((issue) => issue.message.includes(DIRTY_EVENT.id))).toBe(true);
    const messages = issues.map((issue) => issue.message).join('\n');
    expect(messages).toContain('«Bach» debe ser «Johann Sebastian Bach»');
    expect(messages).toContain('«Varios autores» no es una persona-compositor; valor esperado: (omitir)');
    expect(messages).toContain('duplica la identidad «Johann Sebastian Bach»');
    expect(messages).toContain(
      'works[1].composerName «Tradicional de Venezuela» no es una persona-compositor; valor esperado: (omitir)',
    );
    expect(messages).toContain('«JAVIER MARTÍNEZ CAMPOS» debe ser «Javier Martínez Campos»');
    expect(validateRawFiles(filesFromCatalog(catalog)).ok).toBe(false);
  });

  it('acepta un compositor legítimo desconocido', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          composers: [{ name: 'Marina Vespertilio' }],
          works: [{ title: 'Estudio', composerName: 'Marina Vespertilio' }],
        }),
      ],
    });
    expect(findComposerIdentityIssues(catalog)).toEqual([]);
    expect(validateRawFiles(filesFromCatalog(catalog)).ok).toBe(true);
  });

  it('acepta un evento ya canonicalizado', () => {
    const clean = { ...DIRTY_EVENT, ...canonicalizePublishedComposerFields(DIRTY_EVENT) };
    expect(findComposerIdentityIssues(makeCatalog({ events: [clean] }))).toEqual([]);
  });
});

describe('catálogo publicado', () => {
  it('el catálogo completo ya cumple la canonicalización compartida', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    expect(findComposerIdentityIssues(catalog)).toEqual([]);
    const audit = auditPublishedComposers(catalog.events);
    expect(audit.eventsChanged).toBe(0);
    expect(audit.mentionsRewritten).toBe(0);
    expect(audit.aliases).toEqual([]);
    expect(audit.withLifespan).toEqual([]);
    expect(audit.pseudo).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(audit.allCaps).toEqual([]);
  });
});
