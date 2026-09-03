import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { isPublishableInclude } from '../src/ingestion/classification/types.ts';
import { resolvePerformerRole } from '../src/ingestion/classification/performer-role.ts';
import { observedFactsSchema } from '../src/ingestion/observed.ts';
import { normalizeRawEvent, observedFactsFromNormalized, type NormalizedEvent } from '../src/ingestion/normalize.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { formatRunSummary } from '../src/ingestion/summary.ts';
import { TEST_NOW } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const ocneDetailPath = path.join(fixtures, 'detail', 'auditorio-ocne-sinfonico-01.excerpt.html');

const OBSERVED_KEYS = new Set([
  'title',
  'description',
  'categoryText',
  'venueText',
  'organizerText',
  'seriesText',
  'accessText',
  'programText',
  'performers',
  'composers',
  'works',
]);

const TECHNICAL_KEYS = ['sourceId', 'sourceUrl', 'externalId', 'occurrences'];

type ListingItem = {
  title: string;
  slug: string;
  start?: string;
  className?: string;
  description?: string;
};

function listingJson(items: ListingItem[]): string {
  return JSON.stringify(
    items.map((item, index) => ({
      title: item.title,
      url: `https://auditorionacional.inaem.gob.es/es/programacion/${item.slug}`,
      start: item.start ?? '2026-09-18T19:30:00+02:00',
      className: item.className ?? 'sinfonica',
      id: `${item.slug}-${index}`,
      ...(item.description ? { description: item.description } : {}),
    })),
  );
}

function countingAi(inner: AiClassifier): AiClassifier & { calls: number; payloads: unknown[] } {
  const spy: AiClassifier & { calls: number; payloads: unknown[] } = {
    calls: 0,
    payloads: [],
    async classify(observed) {
      spy.calls += 1;
      spy.payloads.push(observed);
      return inner.classify(observed);
    },
  };
  return spy;
}

async function runAuditorio(options: {
  items: ListingItem[];
  details?: Record<string, string>;
  ai?: AiClassifier;
  dryRun?: boolean;
  write?: boolean;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-gate-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  const listing = listingJson(options.items);
  return runIngest({
    dataDir: dir,
    catalog: emptyCatalog(),
    now: TEST_NOW,
    dryRun: options.dryRun ?? !options.write,
    sourceIds: ['auditorio-nacional'],
    ai: options.ai,
    get: async (url) => {
      if (url.includes('front-page-events.json')) return listing;
      const detail = options.details
        ? Object.entries(options.details).find(([slug]) => url.includes(slug))
        : undefined;
      if (detail) return detail[1];
      throw new Error(`ficha no mapeada: ${url}`);
    },
  });
}

describe('proyección NormalizedEvent → ObservedFacts', () => {
  it('expone sólo el contrato de ObservedFacts y rechaza metadata técnica', () => {
    const event: NormalizedEvent = {
      sourceId: 'auditorio-nacional',
      sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne',
      externalId: 'secret-external',
      title: 'OCNE. Sinfónico 01',
      description: 'Mahler',
      occurrences: [{ date: '2026-09-18', time: '19:30' }],
      venueText: 'Sala Sinfónica',
      organizerText: 'OCNE',
      seriesText: 'Sinfónico',
      accessText: '40 €',
      categoryText: 'sinfonica',
      programText: 'Mahler — Sinfonía núm. 2',
      performers: [{ name: 'Kent Nagano', roleText: 'director' }],
      composers: [{ name: 'Gustav Mahler' }],
      works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
    };

    expect(() => observedFactsSchema.parse(event)).toThrow();

    const facts = observedFactsFromNormalized(event);
    expect(observedFactsSchema.parse(facts)).toEqual(facts);
    for (const key of TECHNICAL_KEYS) {
      expect(facts).not.toHaveProperty(key);
    }
    for (const key of Object.keys(facts)) {
      expect(OBSERVED_KEYS.has(key), key).toBe(true);
    }
    expect(facts.title).toBe(event.title);
    expect(facts.performers).toEqual(event.performers);
  });
});

describe('publication gate — pipeline completo', () => {
  it('A. include determinista: hidrata, 0 llamadas a IA, Candidate con enrichment', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const ai = countingAi({ async classify() { throw new Error('IA no debe llamarse'); } });
    const run = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
      ai,
    });

    expect(ai.calls).toBe(0);
    expect(run.summary.ai.attempted).toBe(0);
    expect(run.summary.eligibility).toEqual({ include: 1, exclude: 0, uncertain: 0 });
    expect(run.candidates).toHaveLength(1);

    const event = run.candidates[0]!.event;
    const facts = observedFactsFromNormalized(normalizeRawEvent(run.rawEvents[0]!)!);
    const expected = classify(facts);
    expect(isPublishableInclude(expected)).toBe(true);
    if (!isPublishableInclude(expected)) return;
    expect(event.eras).toEqual(expected.eras?.value ?? []);
    expect(event.formats).toEqual(expected.formats?.value ?? []);
    expect(event.kind).toBe(expected.kind.value);
    expect(event.access).toBe(expected.access?.value ?? 'unknown');
    expect(event.kind).toBe('established');
    expect(event.eras).toEqual(expect.arrayContaining(['romantic', 'contemporary']));
    expect(event.formats).toContain('symphonic');
    expect(event.access).toBe('paid');
  });

  it('B. exclude determinista: 0 IA, sin Candidate ni escritura', async () => {
    const ai = countingAi({ async classify() { throw new Error('IA no debe llamarse'); } });
    const run = await runAuditorio({
      items: [{ title: 'Jazz en el Auditorio', slug: 'jazz-auditorio' }],
      ai,
      write: true,
    });

    expect(ai.calls).toBe(0);
    expect(run.summary.eligibility).toEqual({ include: 0, exclude: 1, uncertain: 0 });
    expect(run.candidates).toEqual([]);
    expect(run.summary.written).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
  });

  it('C. uncertain sin provider: no Candidate y el resto del lote continúa', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const run = await runAuditorio({
      items: [
        { title: 'Concierto extraordinario', slug: 'concierto-extraordinario' },
        { title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' },
      ],
      details: { 'ocne-sinfonico-01': detail },
    });

    expect(run.summary.ai.attempted).toBe(0);
    expect(run.summary.eligibility.uncertain).toBe(1);
    expect(run.summary.eligibility.include).toBe(1);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.title).toBe('OCNE. Sinfónico 01');
  });

  it('D. uncertain + fake AI include: Candidate con enrichment de IA', async () => {
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['chamber'],
          eras: ['baroque'],
          kind: 'alternative',
          evidence: ['fake include'],
        };
      },
    });
    const run = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'concierto-extraordinario' }],
      ai,
    });

    expect(ai.calls).toBe(1);
    expect(run.summary.ai).toEqual(expect.objectContaining({ attempted: 1, resolved: 1, unresolved: 0, include: 1 }));
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.formats).toEqual(['chamber']);
    expect(run.candidates[0]!.event.eras).toEqual(['baroque']);
    expect(run.candidates[0]!.event.kind).toBe('established');
  });

  it('E. uncertain + fake AI exclude: no Candidate', async () => {
    const ai = countingAi({ async classify() { return { eligibility: 'exclude' }; } });
    const run = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'gala-exclude' }],
      ai,
    });
    expect(ai.calls).toBe(1);
    expect(run.summary.eligibility.exclude).toBe(1);
    expect(run.candidates).toEqual([]);
  });

  it('F. uncertain + fake AI uncertain: no Candidate', async () => {
    const ai = countingAi({ async classify() { return { eligibility: 'uncertain' }; } });
    const run = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'gala-uncertain' }],
      ai,
    });
    expect(ai.calls).toBe(1);
    expect(run.summary.eligibility.uncertain).toBe(1);
    expect(run.summary.ai).toEqual(expect.objectContaining({ attempted: 1, resolved: 0, unresolved: 1, uncertain: 1 }));
    expect(run.candidates).toEqual([]);
  });

  it('G. fallo de IA en A no tumba un include determinista B', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const ai = countingAi({
      async classify() {
        throw new Error('provider caído');
      },
    });
    const run = await runAuditorio({
      items: [
        { title: 'Concierto extraordinario', slug: 'evento-a-uncertain' },
        { title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' },
      ],
      details: { 'ocne-sinfonico-01': detail },
      ai,
    });

    expect(ai.calls).toBe(1);
    expect(run.summary.eligibility.uncertain).toBe(1);
    expect(run.summary.eligibility.include).toBe(1);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.title).toBe('OCNE. Sinfónico 01');
    expect(run.summary.ai.attempted).toBe(1);
    expect(run.summary.ai.unresolved).toBe(1);
  });

  it('H. el objeto enviado a IA es ObservedFacts, sin metadata técnica', async () => {
    const ai = countingAi({ async classify() { return { eligibility: 'uncertain' }; } });
    await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'frontera-ai' }],
      ai,
    });

    expect(ai.payloads).toHaveLength(1);
    const payload = ai.payloads[0];
    expect(observedFactsSchema.parse(payload)).toEqual(payload);
    for (const key of TECHNICAL_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('hydration');
    if (payload && typeof payload === 'object') {
      for (const key of Object.keys(payload)) {
        expect(OBSERVED_KEYS.has(key), key).toBe(true);
      }
    }
  });

  it('I. include con eras vacías sigue generando Candidate', async () => {
    const ai = countingAi({
      async classify() {
        return { eligibility: 'include', kind: 'alternative', formats: [], eras: [] };
      },
    });
    const run = await runAuditorio({
      items: [{ title: 'Concierto extraordinario', slug: 'include-vacio' }],
      ai,
    });

    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.eras).toEqual([]);
    expect(run.candidates[0]!.event.formats).toEqual([]);
    expect(run.candidates[0]!.event.kind).toBe('established');
    expect(run.candidates[0]!.event.citations[0]?.url).toMatch(/^https:\/\//);
    expect(run.summary.healthReasons).toContain('unresolved-taxonomy');
    expect(run.summary.autoMergeEligible).toBe(true);
  });

  it('una ficha aplazada fuera de 120 días no publica un evento nuevo', async () => {
    const detail = `
      <article id="content">
        <h1>CNDM. Barbara Hannigan</h1>
        <div class="content">
          <h4>CONCIERTO APLAZADO. AL 11 de ABRIL de 2027<br />BARBARA HANNIGAN soprano</h4>
          <h4>Johann Sebastian Bach<br />Suite para violonchelo n.º 3</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="location camara rightColumn__item__text">Sala de Cámara</span>
          </p>
        </div>
      </article>
    `;
    const run = await runAuditorio({
      items: [
        {
          title: 'CNDM. Barbara Hannigan',
          slug: 'cndm-barbara-hannigan',
          start: '2026-09-18T19:30:00+02:00',
          className: 'camara',
        },
      ],
      details: { 'cndm-barbara-hannigan': detail },
    });

    expect(run.rawEvents[0]?.dateFromDetail).toBe(true);
    expect(run.rawEvents[0]?.observed.occurrences[0]?.date).toBe('2027-04-11');
    expect(run.candidates).toEqual([]);
    expect(run.summary.newEvents).toBe(0);
    expect(run.decisions[0]?.structuralSkip?.reason).toBe('fuera de ventana');
    expect(run.decisions[0]?.eligibility).toBeUndefined();
  });

  it('un evento explícitamente cancelado no se publica como activo', async () => {
    const detail = `
      <article id="content">
        <h1>CNDM. Cancelado</h1>
        <div class="content">
          <h4>CONCIERTO CANCELADO<br />Orquesta Nacional de España</h4>
          <h4>Johann Sebastian Bach<br />Suite orquestal</h4>
        </div>
        <div class="rightcolumn">
          <p class="rightColumn__item">
            <label class="rightColumn__item__label">Sala:</label>
            <span class="rightColumn__item__text">Sala Sinfónica</span>
          </p>
        </div>
      </article>
    `;
    const run = await runAuditorio({
      items: [{ title: 'CNDM. Cancelado', slug: 'cndm-cancelado' }],
      details: { 'cndm-cancelado': detail },
    });

    expect(run.rawEvents[0]?.eventStatus).toBe('cancelled');
    expect(run.candidates).toEqual([]);
    expect(run.decisions[0]?.structuralSkip?.reason).toBe('cancelado');
  });

  it('J. roles inequívocos se copian y los ambiguos se omiten', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const run = await runAuditorio({
      items: [{ title: 'OCNE. Sinfónico 01', slug: 'ocne-sinfonico-01-1' }],
      details: { 'ocne-sinfonico-01': detail },
    });

    const performers = run.candidates[0]!.event.performers;
    const nagano = performers.find((item) => item.name === 'Kent Nagano');
    const soprano = performers.find((item) => item.name === 'Jane Archibal');
    expect(nagano?.role).toBe('conductor');
    expect(soprano?.role).toBeUndefined();
  });

  it('exclude/uncertain no consumen slugs ni IDs de un include posterior', async () => {
    const detail = await readFile(ocneDetailPath, 'utf8');
    const run = await runAuditorio({
      items: [
        { title: 'Concierto extraordinario', slug: 'evento-uncertain' },
        { title: 'Concierto extraordinario', slug: 'ocne-sinfonico-01-1' },
      ],
      details: { 'ocne-sinfonico-01': detail },
    });

    expect(run.summary.eligibility.uncertain).toBe(1);
    expect(run.summary.eligibility.include).toBe(1);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.slug).toBe('concierto-extraordinario');
  });

  it('un include sin kind no es publicable', () => {
    expect(
      isPublishableInclude({
        eligibility: { value: 'include', method: 'rule', ruleId: 'broken', evidence: [] },
      }),
    ).toBe(false);
    expect(
      isPublishableInclude({
        eligibility: { value: 'include', method: 'rule', ruleId: 'ok', evidence: [] },
        kind: { value: 'alternative', method: 'fallback', ruleId: 'kind-alternative-fallback', evidence: [] },
      }),
    ).toBe(true);
  });

  it('el summary separa descartes estructurales de classification y de IA', async () => {
    const run = await runAuditorio({
      items: [
        { title: 'Jazz en el Auditorio', slug: 'jazz-ok' },
        { title: 'Concierto extraordinario', slug: 'gala' },
        { title: 'Fuera de ventana', slug: 'pasado', start: '2026-01-01T19:30:00+01:00' },
      ],
    });

    expect(run.summary.eligibility).toEqual({ include: 0, exclude: 1, uncertain: 1 });
    expect(run.summary.skippedUnusable).toBe(1);
    expect(run.summary.ai.attempted).toBe(0);
    expect(run.candidates).toEqual([]);

    const text = formatRunSummary(run.summary);
    expect(text).toMatch(/Clasificación:\n {2}include: 0\n {2}exclude: 1\n {2}uncertain: 1/);
    expect(text).toMatch(/IA:\n {2}intentadas: 0\n {2}resueltas: 0\n {2}sin resolver: 0/);
    expect(text).toMatch(/Descartados estructuralmente: 1/);
    expect(text).toMatch(/Candidatos generados: 0/);
    expect(text).not.toMatch(/sin fecha\/lugar/);
  });
});

describe('resolvePerformerRole', () => {
  it('mapea sólo casos inequívocos y omite instrumentos o voces', () => {
    expect(resolvePerformerRole('orquesta')).toBe('orchestra');
    expect(resolvePerformerRole('Orchestra')).toBe('orchestra');
    expect(resolvePerformerRole('coro')).toBe('choir');
    expect(resolvePerformerRole('choir')).toBe('choir');
    expect(resolvePerformerRole('chorus')).toBe('choir');
    expect(resolvePerformerRole('director')).toBe('conductor');
    expect(resolvePerformerRole('directora')).toBe('conductor');
    expect(resolvePerformerRole('dirección musical')).toBe('conductor');
    expect(resolvePerformerRole('conductor')).toBe('conductor');
    expect(resolvePerformerRole('ensemble')).toBe('ensemble');
    expect(resolvePerformerRole('solista')).toBe('soloist');
    expect(resolvePerformerRole('soloist')).toBe('soloist');

    expect(resolvePerformerRole('piano')).toBeUndefined();
    expect(resolvePerformerRole('violín')).toBeUndefined();
    expect(resolvePerformerRole('soprano')).toBeUndefined();
    expect(resolvePerformerRole('mezzosoprano')).toBeUndefined();
    expect(resolvePerformerRole('other')).toBeUndefined();
    expect(resolvePerformerRole(undefined)).toBeUndefined();
  });
});
