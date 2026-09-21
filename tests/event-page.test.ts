import { describe, expect, it } from 'vitest';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { makeCatalog, makeEvent, richCatalog, testClock } from './helpers.ts';

describe('perfil de la ficha de evento', () => {
  it('ordena la clasificación y deja la programación en segundo plano', () => {
    const page = buildEventPageModel(makeCatalog(), 'matinees-de-otono', testClock);

    expect(page?.concertProfile).toEqual([
      { label: 'Acceso', value: 'De pago', quiet: false },
      { label: 'Formato', value: 'Sinfónico', quiet: false },
      { label: 'Época', value: 'Clasicismo, Romanticismo', quiet: false },
      { label: 'Organiza', value: 'Orquesta y Coro Nacionales de España', quiet: false },
      { label: 'Programación', value: 'Circuito habitual', quiet: true },
    ]);
  });

  it('omite acceso, formato, época y organiza cuando no hay datos', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          access: 'unknown',
          formats: [],
          eras: [],
          organizerIds: [],
          kind: 'alternative',
          performers: [],
          composers: [],
          works: [],
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);

    expect(page?.concertProfile).toEqual([
      { label: 'Programación', value: 'Alternativo', quiet: true },
    ]);
    expect(page?.performers).toEqual([]);
    expect(page?.composers).toEqual([]);
    expect(page?.works).toEqual([]);
  });

  it('muestra el acceso gratuito y conserva compositores sin programa', () => {
    const page = buildEventPageModel(richCatalog(), 'recital-de-organo', testClock);

    expect(page?.concertProfile.map((item) => item.label)).toEqual([
      'Acceso',
      'Formato',
      'Época',
      'Programación',
    ]);
    expect(page?.concertProfile[0]).toEqual({ label: 'Acceso', value: 'Gratuito', quiet: false });
    expect(page?.composers).toEqual(['Johann Sebastian Bach']);
    expect(page?.works).toEqual([]);
    expect(page?.spaceName).toBeNull();
  });

  it('marca como pasado un evento ya celebrado sin bajar el estado crítico', () => {
    const past = buildEventPageModel(richCatalog(), 'concierto-de-verano', testClock);
    expect(past?.isPast).toBe(true);
    expect(past?.statusLabel).toBe('Programado');

    for (const [status, label] of [
      ['cancelled', 'Cancelado'],
      ['postponed', 'Aplazado'],
    ] as const) {
      const catalog = makeCatalog({ events: [makeEvent({ status })] });
      const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);
      expect(page?.isPast).toBe(false);
      expect(page?.statusLabel).toBe(label);
    }
  });
});
