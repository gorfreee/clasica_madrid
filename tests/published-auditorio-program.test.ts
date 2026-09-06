import { describe, expect, it } from 'vitest';
import {
  looksLikeEnsembleName,
  looksLikeMovementLine,
  looksLikePartHeader,
  looksLikeProgramHeader,
} from '../src/ingestion/observed-cleanup.ts';
import { parseAuditorioNacionalDetail } from '../src/ingestion/detail/auditorio-nacional.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Event } from '../src/lib/schemas/index.ts';

const AUDITORIO = 'src_auditorio_nacional';

/** Confirmed section headings that the old Auditorio parser published as composers. */
const CONFIRMED_SECTION_HEADINGS =
  /^(?:like a boho|rapsodia roman[ií]|baile y enso[nñ]aci[oó]n|viajando con la m[uú]sica|grandes coros de oratorios|overture|utop[ií]as|la flauta bohemia|fascinaci[oó]n carmen)$/i;

function citesAuditorio(event: Event): boolean {
  return event.primarySourceId === AUDITORIO || event.citations.some((item) => item.sourceId === AUDITORIO);
}

/**
 * High-confidence false composers from the historical Auditorio parser.
 * Intentionally narrow: contemporary names with biographical years must pass.
 */
export function isHighConfidenceFalseAuditorioComposer(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (looksLikeMovementLine(trimmed)) return true;
  if (looksLikeProgramHeader(trimmed) || looksLikePartHeader(trimmed)) return true;
  if (/^de\s+/i.test(trimmed)) return true;
  if (looksLikeEnsembleName(trimmed)) return true;
  if (CONFIRMED_SECTION_HEADINGS.test(trimmed)) return true;
  return false;
}

function composerFields(event: Event): Array<{ field: string; value: string }> {
  const rows: Array<{ field: string; value: string }> = [];
  for (const composer of event.composers) {
    rows.push({ field: 'composers[]', value: composer.name });
  }
  for (const work of event.works) {
    if (work.composerName) rows.push({ field: 'works[].composerName', value: work.composerName });
  }
  return rows;
}

describe('clases de contaminación de alta confianza (Auditorio)', () => {
  it('detecta movimientos, partes, de-colecciones y ensembles, no contemporáneos', () => {
    expect(isHighConfidenceFalseAuditorioComposer('III. Presto')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('I. Introitus')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('I. PRÍNCIPE HEREDERO (1527-1547)')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('PARTE I')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('PARTE II')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('De Selva morale e spirituale (1641)')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('ORQUESTRA DE LA COMUNITAT VALENCIANA')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('Ballet Nacional de España')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('LIKE A BOHO')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('RAPSODIA ROMANÍ')).toBe(true);
    expect(isHighConfidenceFalseAuditorioComposer('BAILE Y ENSOÑACIÓN')).toBe(true);

    expect(isHighConfidenceFalseAuditorioComposer('Adam Ilyas Kuruc (1984-)')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('Christian Fritz (1988-)')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('Marina Vespertilio (1991)')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('JAVIER MARTÍNEZ CAMPOS (1989)')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('Francis Poulenc (1899-1963)')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('R. Gil Roldán')).toBe(false);
    expect(isHighConfidenceFalseAuditorioComposer('Tradicional de Venezuela')).toBe(false);
  });
});

describe('catálogo publicado: programa del Auditorio', () => {
  it('no publica compositores de alta confianza inventados por el parser antiguo', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const auditorioEvents = catalog.events.filter(citesAuditorio);
    expect(auditorioEvents.length).toBeGreaterThan(200);

    const hits: string[] = [];
    for (const event of auditorioEvents) {
      for (const row of composerFields(event)) {
        if (isHighConfidenceFalseAuditorioComposer(row.value)) {
          hits.push(`${event.id} ${row.field}=${row.value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('UAM Spark reconstruye las relaciones de la ficha oficial, no los headings', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const event = catalog.events.find((item) => item.id === 'evt_auditorio_nacional_uam');
    expect(event).toBeTruthy();
    const composers = event!.composers.map((item) => item.name);
    const works = event!.works;

    expect(composers.some((name) => CONFIRMED_SECTION_HEADINGS.test(name))).toBe(false);
    expect(composers).toEqual(
      expect.arrayContaining([
        'Sebastian Bartmann (*1979)',
        'Léo Delibes (1836-1891)',
        'Francis Poulenc (1899-1963)',
        'Michael Nyman (1944-)',
        'Adam Ilyas Kuruc (1984-)',
        'Charles Aznavour (1924-2018)',
        'Elena Kats-Chernin (1957-)',
      ]),
    );
    expect(composers.some((name) => /^le roi s'amuse/i.test(name))).toBe(false);
    expect(composers.some((name) => /la boh[eè]me/i.test(name))).toBe(false);
    expect(works).toEqual(
      expect.arrayContaining([
        { title: 'Toccata FP 48:3 (1928)', composerName: 'Francis Poulenc (1899-1963)' },
        {
          title: 'Chasing Sheep is best left to Shepherds (1982)',
          composerName: 'Michael Nyman (1944-)',
        },
        { title: 'Bohemian Suite (2025/26)', composerName: 'Adam Ilyas Kuruc (1984-)' },
        { title: 'La Bohème (1965)', composerName: 'Charles Aznavour (1924-2018)' },
        { title: 'Fast Blue Village (2022)', composerName: 'Elena Kats-Chernin (1957-)' },
      ]),
    );
    expect(works.some((work) => CONFIRMED_SECTION_HEADINGS.test(work.composerName ?? ''))).toBe(false);
    expect(works.some((work) => CONFIRMED_SECTION_HEADINGS.test(work.title))).toBe(false);
    expect(works.some((work) => /christian fritz/i.test(work.title))).toBe(false);
  });

  it('el excerpt UAM del parser corregido sigue alineado con el catálogo saneado', async () => {
    const html = await readFile(
      path.join(import.meta.dirname, 'fixtures/ingestion/detail/auditorio-uam-spark.excerpt.html'),
      'utf8',
    );
    const facts = parseAuditorioNacionalDetail(html);
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const event = catalog.events.find((item) => item.id === 'evt_auditorio_nacional_uam');
    const published = new Set(event!.composers.map((item) => item.name));
    for (const name of facts.composers?.map((item) => item.name) ?? []) {
      if (isHighConfidenceFalseAuditorioComposer(name)) continue;
      if (/^georges bizet$/i.test(name)) continue;
      const normalized = name.replace(/\s+/g, ' ').replace(/\(1988\s*-\)/, '(1988-)');
      expect(
        [...published].some((item) => item.replace(/\s+/g, ' ').replace(/\(1988\s*-\)/, '(1988-)') === normalized),
        `composer ${name} missing from published UAM`,
      ).toBe(true);
    }
  });
});
