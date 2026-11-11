import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AiClassifier, AiEligibilityResult } from '../src/ingestion/classification/ai.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import {
  hasObservedClassicalAcademicAnchor,
  hasSubstantialClassicalBlock,
  resolveEligibility,
} from '../src/ingestion/classification/eligibility.ts';
import { matchComposer } from '../src/ingestion/knowledge/composers.ts';
import { observedFactsSchema, type ObservedFacts } from '../src/ingestion/observed.ts';

const captured = JSON.parse(await readFile(
  new URL('./fixtures/ingestion/eligibility-programme/run-39603845469.json', import.meta.url),
  'utf8',
)) as Array<{ sourceUrl: string; observed: ObservedFacts }>;
const programmes = captured.map((item) => observedFactsSchema.parse(item.observed));

function facts(overrides: Partial<ObservedFacts>): ObservedFacts {
  return { title: 'Velada', performers: [], composers: [], works: [], ...overrides };
}

function fakeAi(response: AiEligibilityResult) {
  const purposes: string[] = [];
  const ai: AiClassifier = {
    async classify(_facts, context) {
      purposes.push(context!.purpose!);
      if (context?.purpose === 'eligibility') return response;
      // Metadata is intentionally unresolved: an eligibility anchor must not
      // itself invent an era or add composers via a second fake response.
      if (context?.purpose === 'composer-extraction') return { candidates: [] };
      return { formats: [], eras: [], evidence: [] };
    },
  };
  return { ai, purposes };
}

// Synthetic programme for an additional author absent from local knowledge.
const pejacevic = facts({
  title: 'Velada de cámara',
  categoryText: 'Concierto',
  performers: [{ name: 'Dúo del Norte' }],
  composers: [{ name: 'Dora Pejačević' }],
  works: [
    { title: 'Sonata para violonchelo y piano en Mi menor, op. 35', composerName: 'Dora Pejačević' },
    { title: 'Sonata para violín y piano en Re mayor, op. 26', composerName: 'Dora Pejačević' },
  ],
  programText: 'Dora Pejačević: Sonata para violonchelo y piano en Mi menor, op. 35; Sonata para violín y piano en Re mayor, op. 26.',
});

describe('attributed programme → eligibility AI anchor, independent of composer knowledge', () => {
  it.each([...programmes, pejacevic].map((observed) => [observed.title, observed] as const))(
    '%s: accepts grounded AI include, without changing the deterministic/block thresholds or eras',
    async (_title, observed) => {
      for (const composer of observed.composers) expect(matchComposer(composer.name)).toBeUndefined();
      expect(resolveEligibility(observed)).toMatchObject({ value: 'uncertain', ruleId: 'insufficient-evidence' });
      expect(hasSubstantialClassicalBlock(observed)).toBe(false);
      expect(hasObservedClassicalAcademicAnchor(observed)).toBe(true);

      const { ai, purposes } = fakeAi({ eligibility: 'include', evidence: [observed.programText!] });
      const result = await classifyObserved(observed, { ai });
      expect(result.eligibility).toMatchObject({ value: 'include', method: 'ai', ruleId: 'ai-include' });
      expect(purposes.filter((purpose) => purpose === 'eligibility')).toHaveLength(1);
      expect(result.eras?.value).toEqual([]);
      expect((await classifyObserved(observed)).eligibility.value).toBe('uncertain');
    },
  );

  it.each(programmes.map((observed) => [observed.title, observed] as const))(
    '%s: still rejects an invented citation despite the new programme anchor',
    async (_title, observed) => {
      const { ai, purposes } = fakeAi({
        eligibility: 'include',
        evidence: [observed.works[0]!.title, 'Programa académico de sonatas de Beethoven'],
      });
      const result = await classifyObserved(observed, { ai });
      expect(result.eligibility).toMatchObject({ value: 'uncertain', ruleId: 'ai-ungrounded-evidence' });
      expect(purposes).toEqual(['eligibility']);
    },
  );

  it('preserves the original ungrounded Oro en la Edad de Plata III rejection', async () => {
    const observed = programmes[2]!;
    const { ai } = fakeAi({
      eligibility: 'include',
      evidence: ['Fuga real a tres motivos de Bartolomé Pérez Casas'],
    });
    expect((await classifyObserved(observed, { ai })).eligibility.ruleId).toBe('ai-ungrounded-evidence');
  });

  it('a single specific work needs independent musical programme context', async () => {
    const single = facts({
      ...pejacevic,
      works: pejacevic.works.slice(0, 1),
      programText: undefined,
      description: 'El programa explora formas de música de cámara.',
    });
    const { ai } = fakeAi({ eligibility: 'include', evidence: [single.works[0]!.title] });
    expect(resolveEligibility(single).value).toBe('uncertain');
    expect((await classifyObserved(single, { ai })).eligibility.value).toBe('include');
    expect(hasObservedClassicalAcademicAnchor({ ...single, description: undefined })).toBe(false);
  });

  it('numbered catalogues can identify attributed works without tonalities or a composers list', async () => {
    const observed = facts({
      title: 'Velada',
      works: pejacevic.works.map((work) => ({
        ...work, title: work.title.replace(/ en .*?,/, ','),
      })),
    });
    expect(resolveEligibility(observed).value).toBe('uncertain');
    expect(hasObservedClassicalAcademicAnchor(observed)).toBe(true);
    const { ai } = fakeAi({ eligibility: 'include', evidence: [observed.works[0]!.title] });
    expect((await classifyObserved(observed, { ai })).eligibility.ruleId).toBe('ai-include');
  });

  const incomplete = [
    facts({ title: 'Cuarteto del Norte', composers: [{ name: 'Dora Pejačević' }] }),
    facts({ title: 'Recital', programText: 'Dora Pejačević. Programa por determinar.' }),
    facts({ title: 'Cuarteto', works: [{ title: 'Cuarteto', composerName: 'Autor desconocido' }] }),
    facts({ ...pejacevic, works: pejacevic.works.map(({ title }) => ({ title })) }),
    facts({ ...pejacevic, works: [pejacevic.works[0]!, pejacevic.works[0]!], programText: undefined }),
    facts({ title: 'Quinteto', venueText: 'Auditorio Nacional', organizerText: 'Fundación Juan March' }),
    facts({ title: 'Cuarteto', programText: 'Sonata Suite Nocturno', composers: [{ name: 'Autor desconocido' }] }),
    facts({
      title: 'Las canciones de Luna',
      composers: [{ name: 'Luna' }],
      works: [{ title: 'Sonata', composerName: 'Luna' }, { title: 'Nocturno', composerName: 'Luna' }],
      programText: 'Luna: Sonata; Nocturno.',
    }),
    facts({ ...programmes[3]!, programText: 'K. Jenkins: "The armed man: una misa para la paz"' }),
    facts({ ...programmes[3]!, programText: 'Orquestas Sinfónica OJEM y Junior LFM. K. Jenkins.' }),
    facts({ ...programmes[3]!, programText: 'Escuela Coral OJEM. K. Jenkins.' }),
  ];

  it.each(incomplete.map((observed, index) => [index, observed] as const))(
    'incomplete or ambiguous programme %i cannot be forced through with literal AI evidence',
    async (_index, observed) => {
      expect(resolveEligibility(observed).ruleId).toBe('insufficient-evidence');
      expect(hasObservedClassicalAcademicAnchor(observed)).toBe(false);
      const { ai, purposes } = fakeAi({ eligibility: 'include', evidence: [observed.title] });
      const result = await classifyObserved(observed, { ai });
      expect(result.eligibility).toMatchObject({ value: 'uncertain', ruleId: 'ai-weak-include-evidence' });
      expect(purposes).toEqual(['eligibility']);
    },
  );

  it('a valid AI uncertain remains uncertain even with an eligible programme anchor', async () => {
    const { ai, purposes } = fakeAi({ eligibility: 'uncertain', evidence: [] });
    expect((await classifyObserved(pejacevic, { ai })).eligibility.ruleId).toBe('ai-uncertain');
    expect(purposes).toEqual(['eligibility']);
  });

  it.each(['jazz', 'pop'])('does not bypass a principal %s identity with classical-looking work titles', async (genre) => {
    const observed = facts({
      title: `Cuarteto de ${genre}`,
      categoryText: genre,
      composers: [{ name: 'Luna' }],
      works: pejacevic.works.map((work) => ({ ...work, composerName: 'Luna' })),
      programText: `Luna: ${pejacevic.works.map((work) => work.title).join('; ')}.`,
    });
    expect(resolveEligibility(observed).value).toBe('exclude');
    expect(hasObservedClassicalAcademicAnchor(observed)).toBe(false);
    const { ai, purposes } = fakeAi({ eligibility: 'include', evidence: [observed.programText!] });
    expect((await classifyObserved(observed, { ai })).eligibility.value).toBe('exclude');
    expect(purposes).toEqual([]);
  });

  it('does not accept jazz work titles as classical evidence when only works[] carries the genre', async () => {
    const observed = facts({
      title: 'Cuarteto del Norte',
      works: [
        { title: 'Jazz Sonata en Do mayor, op. 1', composerName: 'Luna' },
        { title: 'Jazz Suite en Re menor, op. 2', composerName: 'Luna' },
      ],
    });
    expect(resolveEligibility(observed).ruleId).toBe('insufficient-evidence');
    expect(hasObservedClassicalAcademicAnchor(observed)).toBe(false);
    const { ai } = fakeAi({ eligibility: 'include', evidence: [observed.works[0]!.title] });
    expect((await classifyObserved(observed, { ai })).eligibility.ruleId).toBe('ai-weak-include-evidence');
  });

  it('a programme anchor cannot become the substantial block needed for a coprincipal mix', async () => {
    const observed = facts({ ...pejacevic, description: 'Este programa combina música de cámara y jazz.' });
    expect(hasSubstantialClassicalBlock(observed)).toBe(false);
    expect(resolveEligibility(observed).ruleId).toBe('classical-and-nonclassical-coprincipal');
    const { ai } = fakeAi({ eligibility: 'include', evidence: [observed.programText!] });
    expect((await classifyObserved(observed, { ai })).eligibility.ruleId).toBe('ai-coprincipal-without-classical-block');
  });
});
