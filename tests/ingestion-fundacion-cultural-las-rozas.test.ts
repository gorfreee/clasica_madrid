import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import {
  fundacionCulturalLasRozasAdapter as adapter,
  parseLasRozasDetail,
  parseLasRozasListing,
} from '../src/ingestion/sources/fundacion-cultural-las-rozas.ts';
import { IncompleteListingError, type AdapterContext } from '../src/ingestion/types.ts';

const source = getSourceDefinition(adapter.id);
const now = new Date('2026-09-27T10:00:00Z');
const window = { from: '2026-09-27', to: '2026-12-19' };
const url = source.urls[0]!;
const fixture = (name: string) => readFile(path.join(import.meta.dirname,
  'fixtures/ingestion/fundacion-cultural-las-rozas', name), 'utf8');
const ctx: AdapterContext = { source, now, window, get: async () => { throw Error('sin red'); } };

describe('Fundación Cultural Las Rozas', () => {
  it('recorre la agenda activa, conserva categorías y URLs oficiales y no inventa funciones de un intervalo', async () => {
    const events = parseLasRozasListing(await fixture('listing.html'), url, ctx);
    expect(adapter.resolveFetchUrls(source, now, window)).toEqual([url]);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      externalId: '8786',
      sourceUrl: 'https://fundacionculturalasrozas.org/agenda/el-carnaval-de-los-animales-c-saint-saens/',
      observed: {
        title: 'EL CARNAVAL DE LOS ANIMALES.', categoryText: 'Música',
        venueText: 'Auditorio Joaquín Rodrigo', occurrences: [{ date: '2026-10-04', time: '12:00' }],
      },
    });
    expect(events[1]?.observed.occurrences).toEqual([
      { raw: expect.any(String), date: '2026-11-13', time: '19:00' },
      { raw: expect.any(String), date: '2026-11-14', time: '19:00' },
    ]);
    expect(events[2]?.observed.occurrences).toEqual([{ raw: expect.any(String), date: '2026-12-19', time: '20:00' }]);
  });

  it('verifica la identidad de la ficha y obtiene descripción, sala y precio publicado', async () => {
    const event = parseLasRozasListing(await fixture('listing.html'), url, ctx)[0]!;
    const detail = await fixture('detail-carnaval.html');
    expect(parseLasRozasDetail(event, detail)).toMatchObject({
      description: expect.stringContaining('Camille Saint-Saëns'),
      venueText: 'Auditorio Joaquín Rodrigo', accessText: 'Precio: Gratuito',
    });
    expect(() => parseLasRozasDetail(event, detail.replace('4 oct', '5 oct'))).toThrow(/fecha distinta/);
    expect(() => parseLasRozasDetail(event, detail.replace('fundacionculturalasrozas.org/agenda/el-carnaval', 'evil.example/agenda/el-carnaval')))
      .toThrow(/identidad/);
  });

  it('falla ante navegación nueva, tarjeta truncada, URL externa o vacío ambiguo; deduplica sin ocultar conflictos', async () => {
    const body = await fixture('listing.html');
    expect(() => parseLasRozasListing(body, 'https://otro.example/agenda/', ctx)).toThrow(/ajeno/);
    expect(() => parseLasRozasListing(body.replace('&quot;enabled&quot;:false', '&quot;enabled&quot;:true'), url, ctx))
      .toThrow(/paginación/);
    expect(() => parseLasRozasListing(body.replace('https://fundacionculturalasrozas.org/agenda/el-carnaval', 'https://otro.example/agenda/el-carnaval'), url, ctx))
      .toThrow(/hechos básicos/);
    expect(() => parseLasRozasListing(body.slice(0, -7), url, ctx)).toThrow(/truncada/);
    const empty = body.slice(0, body.indexOf('<div class="jet-listing-grid__item jet-listing')) + '</div></div></html>';
    expect(() => parseLasRozasListing(empty, url, ctx)).toThrow(/vacía/);
    const card = /<div class="jet-listing-grid__item jet-listing-dynamic-post-8786[\s\S]*?(?=<div class="jet-listing-grid__item)/.exec(body)![0];
    expect(parseLasRozasListing(body.replace(card, card + card), url, ctx)).toHaveLength(3);
    expect(() => parseLasRozasListing(body.replace(card, card + card.replace('4 oct', '5 oct')), url, ctx))
      .toThrow(/contradictorios/);
  });

  it('protege desapariciones cuando la ventana supera lo publicado y ejecuta el pipeline sin escribir', async () => {
    const listing = await fixture('listing.html');
    expect(() => parseLasRozasListing(listing, url, { ...ctx, window: { ...window, to: '2027-01-25' } }))
      .toThrow(IncompleteListingError);
    const detail = await fixture('detail-carnaval.html');
    const result = await runIngest({
      now, window, dryRun: true, catalog: emptyCatalog(), sourceIds: [source.id],
      dataDir: await mkdtemp(path.join(os.tmpdir(), 'las-rozas-ingest-')),
      get: async (href) => {
        if (href === url) return listing;
        if (href.includes('el-carnaval-de-los-animales')) return detail;
        // The other two cards have their own canonical URL and observed date in the fixture.
        const event = parseLasRozasListing(listing, url, ctx).find((item) => item.sourceUrl === href)!;
        return `<html><link rel="canonical" href="${href}"/><h1 class="elementor-heading-title">${event.observed.title}</h1>` +
          `<div data-id="09f5817"><p class="elementor-heading-title">${event.listingDateText}</p></div></html>`;
      },
    });
    expect(result.summary.sourcesSucceeded, JSON.stringify(result.summary.sourcesFailed)).toContain(source.id);
    expect(result.summary.sourcesFailed).toEqual([]);
    expect(result.summary.written).toEqual([]);
  });

  it('mantiene el año de la temporada anterior si la agenda sigue publicada en enero', async () => {
    const listing = await fixture('listing.html');
    try {
      parseLasRozasListing(listing, url, {
        ...ctx, now: new Date('2027-01-10T10:00:00Z'),
        window: { from: '2027-01-10', to: '2027-04-01' },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteListingError);
      expect((error as IncompleteListingError).events[0]?.observed.occurrences[0]?.date).toBe('2026-10-04');
      return;
    }
    throw new Error('Se aceptó una agenda pasada como programación de 2027');
  });
});
