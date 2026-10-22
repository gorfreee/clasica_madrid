import { describe, expect, it } from 'vitest';
import { resolveEligibility } from '../src/ingestion/classification/eligibility.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const facts = (overrides: Partial<ObservedFacts>): ObservedFacts => ({
  title: 'Concierto', performers: [], composers: [], works: [], ...overrides,
});

describe('eligibility integration: principal activity and performed repertoire', () => {
  it('does not mistake composer credits for a performed classical block', () => {
    const result = resolveEligibility(facts({
      title: 'Tributo a ABBA',
      composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Ludwig van Beethoven' }],
      programText: 'ABBA: Mamma Mia. Queen: Bohemian Rhapsody.',
      performers: [{ name: 'Pop Orchestra', roleText: 'orquesta' }],
    }));
    expect(result).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
  });

  it('does not treat one isolated classical suite in a popular bill as a standalone block', () => {
    const result = resolveEligibility(facts({
      title: 'Tributo a ABBA',
      composers: [{ name: 'Johann Sebastian Bach' }],
      programText: 'ABBA: Mamma Mia. Bach: Suite BWV 1007. Queen: Bohemian Rhapsody.',
    }));
    expect(result.value).not.toBe('include');
  });

  it('sees popular works even when the programme is only available in works[]', () => {
    const result = resolveEligibility(facts({
      title: 'Velada de cámara',
      composers: [{ name: 'Johann Sebastian Bach' }],
      works: [
        { title: 'Mamma Mia', composerName: 'ABBA' },
        { title: 'Suite BWV 1007', composerName: 'Johann Sebastian Bach' },
      ],
    }));
    expect(result).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    expect(result.evidence).toContain('works: ABBA: Mamma Mia');
  });

  it('sees film-music works with their score attribution even when programText is absent', () => {
    const result = resolveEligibility(facts({
      title: 'Concierto de gala',
      composers: [{ name: 'Ludwig van Beethoven' }],
      works: [
        { title: 'Star Wars', composerName: 'John Williams' },
        { title: 'Sinfonía n.º 5', composerName: 'Ludwig van Beethoven' },
      ],
    }));
    expect(result).toMatchObject({ value: 'exclude', ruleId: 'film-music-identity' });
    expect(result.evidence).toContain('works: John Williams: Star Wars');
  });

  it('preserves a genuine substantial classical programme with a nonclassical second half', () => {
    const result = resolveEligibility(facts({
      title: 'Concierto de Navidad',
      composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Ludwig van Beethoven' }],
      programText: 'Primera parte: Johann Sebastian Bach: Suite BWV 1007. Ludwig van Beethoven: Sinfonía n.º 5. Segunda parte: ABBA.',
    }));
    expect(result).toMatchObject({ value: 'include', ruleId: 'mixed-program-classical-block' });
  });

  it('keeps a classical chamber programme at Café Central when two works are identified', () => {
    const result = resolveEligibility(facts({
      title: 'Velada de cámara en Café Central',
      categoryText: 'Conciertos Ateneo-Café Central',
      composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Ludwig van Beethoven' }],
      programText: 'Johann Sebastian Bach: Suite. Ludwig van Beethoven: Cuarteto de cuerda.',
    }));
    expect(result).toMatchObject({ value: 'include', ruleId: 'mixed-program-classical-block' });
  });

  it.each([
    ['Proyección del documental sobre Beethoven', undefined],
    ['Cine de verano: una película muda', undefined],
    ['Concierto', 'Cine de verano'],
    ['Concierto', 'Proyección del documental sobre Mozart'],
  ])('excludes an actual screening: %s / %s', (title, categoryText) => {
    const result = resolveEligibility(facts({
      title, categoryText,
      composers: [{ name: 'Johann Sebastian Bach' }],
      programText: 'Johann Sebastian Bach: Suite BWV 1007.',
    }));
    expect(result).toMatchObject({ value: 'exclude', ruleId: 'cinema-projection' });
  });

  it.each(['Su carrera tiene gran proyección internacional.', 'Es una artista con mayor proyección de su generación.'])(
    'does not exclude career projection claims: %s', (description) => {
      const result = resolveEligibility(facts({
        title: 'Recital de violín',
        description,
        composers: [{ name: 'Johann Sebastian Bach' }],
        programText: 'Johann Sebastian Bach: Suite BWV 1007.',
      }));
      expect(result.value).toBe('include');
    },
  );
});
