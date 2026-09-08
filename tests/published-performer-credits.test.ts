import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventSchema } from '../src/lib/schemas/event.ts';

const eventsDir = path.join(import.meta.dirname, '../data/events');

async function loadEvent(id: string) {
  const raw = await readFile(path.join(eventsDir, `${id}.json`), 'utf8');
  return eventSchema.parse(JSON.parse(raw));
}

describe('créditos publicados saneados', () => {
  it('Fuego y Duende guarda el elenco explícito de Monumental', async () => {
    const event = await loadEvent('evt_orquesta_coro_rtve_eventos_fuego_y_duende');
    expect(event.performers.map((item) => item.name)).toEqual([
      'Orquesta Sinfónica y Coro RTVE',
      'Marc Korovitch',
      'Juan Manuel Cañizares',
      'Antonio Najarro',
      'Bailarines de la compañía de Antonio Najarro',
    ]);
    expect(event.performers.find((item) => item.name === 'Marc Korovitch')?.role).toBe('conductor');
    expect(event.composers.some((item) => /verdi|falla|bizet/i.test(item.name))).toBe(true);
  });

  it('Gala de Ópera & Zarzuela guarda orquesta, director y cantantes', async () => {
    const event = await loadEvent('evt_orquesta_coro_rtve_eventos_gala_de_opera_zarzuela');
    expect(event.performers.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'Orquesta y Coro RTVE',
        'Miquel Ortega',
        'Ana Lucrecia García',
        'Aquiles Machado',
        'José Bros',
        'Borja Quiza',
        'Mónica Redondo',
      ]),
    );
    expect(event.performers.find((item) => item.name === 'Miquel Ortega')?.role).toBe('conductor');
    expect(event.performers.some((item) => /todos los cantantes/i.test(item.name))).toBe(false);
  });

  it('Piotr Anderszewski, piano guarda al pianista del título', async () => {
    const event = await loadEvent('evt_circulo_bellas_artes_132433');
    expect(event.performers).toEqual([{ name: 'Piotr Anderszewski' }]);
  });

  it('Andreas Schager no conserva el asterisco de nota al pie', async () => {
    const event = await loadEvent(
      'evt_teatro_zarzuela_es_temporada_ciclo_de_lied_2026_2027_andreas_schager',
    );
    expect(event.performers.map((item) => item.name)).toEqual([
      'Andreas Schager',
      'Guillermo García Calvo',
    ]);
    expect(event.performers.every((item) => !item.name.includes('*'))).toBe(true);
  });

  it('OCNE. Descubre 01 y Excelentia ya no arrastran artefactos tipográficos', async () => {
    const ocne = await loadEvent('evt_auditorio_nacional_ocne_descubre_01_2');
    expect(ocne.performers[0]?.name).toBe('Orquesta y Coro Nacionales de España');
    const excelentia = await loadEvent(
      'evt_auditorio_nacional_excelentia_concierto_piano_schumann_y_beethoven_num_7',
    );
    expect(excelentia.performers.map((item) => item.name)).toContain('Sebastian Lang-Lessing');
    expect(excelentia.performers.some((item) => item.name.includes('·'))).toBe(false);
  });
});
