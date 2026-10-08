import { describe, expect, it } from 'vitest';
import { resolveFormats, strongFormatValues } from '../src/ingestion/classification/formats.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

function event(title: string, name: string, roleText?: string): ObservedFacts {
  return {
    title,
    performers: [{ name, ...(roleText ? { roleText } : {}) }],
    composers: [],
    works: [],
  };
}

describe('orquestas de guitarras — formato, no formación sinfónica', () => {
  it('no convierte la Orquesta de Guitarras de Madrid en sinfónica por su nombre', () => {
    const observed = event(
      'Concierto de la Orquesta de Guitarras de Madrid. Festival Andrés Segovia',
      'Orquesta de Guitarras de Madrid',
      'orquesta',
    );
    expect(resolveFormats(observed).value).not.toContain('symphonic');
    expect(strongFormatValues(observed)).not.toContain('symphonic');
  });

  it('no infiere sinfónico desde un título de orquesta de guitarras sin roles', () => {
    const observed = event('Orquesta de Guitarras de Madrid', 'Jorge Aguilera', 'director');
    expect(resolveFormats(observed).value).not.toContain('symphonic');
  });

  it('mantiene sinfónico para una orquesta sinfónica explícita', () => {
    const observed = event('Concierto sinfónico', 'Orquesta Sinfónica de Madrid', 'orquesta');
    expect(resolveFormats(observed).value).toContain('symphonic');
  });
});
