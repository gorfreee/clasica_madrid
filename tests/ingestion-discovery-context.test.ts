import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDiscoveryContextArgs } from '../src/cli/discovery-context-args.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { defaultIngestWindow } from '../src/ingestion/dates.ts';
import {
  buildDiscoveryContext,
  parseDiscoveryContext,
  serializeDiscoveryContext,
  type DiscoveryContext,
} from '../src/ingestion/discovery-context.ts';
import { discoveryBatchJsonSchema, parseDiscoveryBatch, SHARED_SOURCE_HOSTS } from '../src/ingestion/discovery.ts';
import { SOURCE_REGISTRY } from '../src/ingestion/registry.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { makeCatalog, makeEvent, makeSource, makeVenue, TEST_NOW, TEST_WINDOW } from './helpers.ts';

const fixtureCatalogDir = path.join(
  import.meta.dirname,
  'fixtures',
  'ingestion',
  'discovery-context',
  'catalog',
);

const FINGERPRINT_KEYS = [
  'id',
  'title',
  'venue',
  'dates',
  'performers',
  'sourceHosts',
  'urls',
] as const;

const EVENT_FIELDS_EXCLUDED_FROM_FINGERPRINT = [
  'schemaVersion',
  'slug',
  'status',
  'organizerIds',
  'seriesId',
  'occurrences',
  'composers',
  'works',
  'eras',
  'formats',
  'kind',
  'access',
  'citations',
  'primarySourceId',
  'lastVerifiedAt',
] as const;

const SECRET_OR_OPS_PATTERNS = [
  /GEMINI/i,
  /OPENAI/i,
  /API_KEY/i,
  /INGEST_FETCH_RELAY/i,
  /INGESTION_BOT/i,
  /useFetchRelay/,
  /skipDefaultSync/,
  /adapterId/,
  /Bearer /i,
];

function contextFrom(catalog = makeCatalog(), window = TEST_WINDOW, now = TEST_NOW): DiscoveryContext {
  return buildDiscoveryContext({ catalog, now, window });
}

describe('DiscoveryContext', () => {
  it('usa la ventana indicada y Europe/Madrid', () => {
    const window = { from: '2026-10-01', to: '2026-11-15' };
    const context = contextFrom(makeCatalog(), window);

    expect(context.schemaVersion).toBe(1);
    expect(context.generatedAt).toBe(TEST_NOW.toISOString());
    expect(context.window).toEqual({
      from: '2026-10-01',
      to: '2026-11-15',
      timeZone: 'Europe/Madrid',
    });
  });

  it('sin fechas explícitas, el default es hoy Madrid → +120 días', () => {
    const context = buildDiscoveryContext({
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: defaultIngestWindow(TEST_NOW),
    });
    expect(context.window).toEqual({
      from: TEST_WINDOW.from,
      to: TEST_WINDOW.to,
      timeZone: 'Europe/Madrid',
    });
    expect(context.window.from).toBe('2026-09-01');
    expect(context.window.to).toBe('2026-12-30');
  });

  it('sólo incluye eventos cuya representación intersecta la ventana', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const context = buildDiscoveryContext({
      catalog,
      now: TEST_NOW,
      window: TEST_WINDOW,
    });

    expect(context.coveredEvents.map((event) => event.id)).toEqual(['evt_bach_misa']);
    expect(context.coveredEvents.some((event) => event.id === 'evt_verano_historico')).toBe(false);

    const tight = buildDiscoveryContext({
      catalog,
      now: TEST_NOW,
      window: { from: '2026-07-01', to: '2026-07-01' },
    });
    expect(tight.coveredEvents.map((event) => event.id)).toEqual(['evt_verano_historico']);
    expect(tight.coveredEvents[0]?.dates).toEqual([{ date: '2026-07-01', time: '20:00' }]);
  });

  it('en un evento multi-fecha sólo conserva las representaciones dentro de la ventana', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          occurrences: [
            { id: 'occ_a', date: '2026-09-10', time: '19:00', status: 'scheduled' },
            { id: 'occ_b', date: '2026-09-20', time: '19:00', status: 'scheduled' },
            { id: 'occ_c', date: '2026-12-01', time: null, status: 'scheduled' },
          ],
        }),
      ],
    });
    const context = contextFrom(catalog, { from: '2026-09-15', to: '2026-09-30' });
    expect(context.coveredEvents).toHaveLength(1);
    expect(context.coveredEvents[0]?.dates).toEqual([{ date: '2026-09-20', time: '19:00' }]);
  });

  it('el fingerprint identifica el evento sin copiar el Event completo', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const event = catalog.events.find((item) => item.id === 'evt_bach_misa');
    expect(event).toBeDefined();
    const context = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    const fingerprint = context.coveredEvents.find((item) => item.id === 'evt_bach_misa');
    expect(fingerprint).toEqual({
      id: 'evt_bach_misa',
      title: 'Misa en Si menor',
      venue: { id: 'ven_iglesia_san_jose', name: 'Iglesia de San José' },
      dates: [{ date: '2026-10-12', time: '19:30' }],
      performers: ['Capilla de San José', 'Ana Ruiz'],
      sourceHosts: ['parroquia-san-jose.example', 'www.parroquia-san-jose.example'],
      urls: ['https://www.parroquia-san-jose.example/conciertos/bach'],
    });

    expect(Object.keys(fingerprint ?? {}).sort()).toEqual([...FINGERPRINT_KEYS].sort());
    for (const field of EVENT_FIELDS_EXCLUDED_FROM_FINGERPRINT) {
      expect(fingerprint).not.toHaveProperty(field);
    }

    const serialized = JSON.stringify(fingerprint);
    expect(serialized).not.toContain('Misa en Si menor, BWV 232');
    expect(serialized).not.toContain('Johann Sebastian Bach');
    expect(serialized).not.toContain('checkedAt');
    expect(serialized).not.toContain('"baroque"');
    expect(serialized).not.toContain('"choral"');
    expect(serialized).not.toContain('"alternative"');
    expect(serialized).not.toContain('"free"');
    expect(serialized.length).toBeLessThan(JSON.stringify(event).length);
  });

  it('incluye las sources del registry con listing y hosts, sin duplicar las canónicas harvesteadas', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const context = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    const harvestedIds = context.sources.harvested.map((source) => source.registryId).sort();

    expect(harvestedIds).toEqual([...SOURCE_REGISTRY.map((source) => source.id)].sort());
    expect(context.sources.harvested).toHaveLength(SOURCE_REGISTRY.length);

    const teatro = context.sources.harvested.find((source) => source.registryId === 'teatro-real');
    expect(teatro).toMatchObject({
      catalogSourceId: 'src_teatro_real',
      name: 'Teatro Real',
      homepage: 'https://www.teatroreal.es/es',
    });
    expect(teatro?.listingUrls).toContain('https://www.teatroreal.es/es/calendario');
    expect(teatro?.hosts).toEqual(['teatroreal.es', 'www.teatroreal.es']);

    expect(context.sources.published.map((source) => source.id)).toEqual(['src_parroquia_san_jose']);
    expect(context.sources.published.some((source) => source.id === 'src_teatro_real')).toBe(false);
    expect(new Set(harvestedIds).size).toBe(harvestedIds.length);
  });

  it('incluye venues conocidos del catálogo y aliases reutilizables, no alias internos de source', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const context = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    const ids = context.venues.map((venue) => venue.id);

    expect(ids).toContain('ven_iglesia_san_jose');
    expect(ids).toContain('ven_teatro_real');
    expect(ids).toContain('ven_auditorio_nacional_sala_sinfonica');
    expect(new Set(ids).size).toBe(ids.length);

    const teatro = context.venues.find((venue) => venue.id === 'ven_teatro_real');
    expect(teatro).toMatchObject({
      name: 'Teatro Real',
      municipality: 'Madrid',
      url: 'https://www.teatroreal.es/es',
    });
    expect(teatro?.aliases).toContain('teatro real de madrid');
    expect(teatro?.aliases).not.toContain('teatro real');
    expect(teatro?.aliases).not.toContain('sala principal');
    expect(context.venues.some((venue) => venue.aliases.includes('sala principal'))).toBe(false);
    expect(
      context.venues.find((venue) => venue.id === 'ven_real_teatro_retiro_sala_principal')?.aliases,
    ).toContain('sala principal real teatro de retiro');

    const parish = context.venues.find((venue) => venue.id === 'ven_iglesia_san_jose');
    expect(parish?.aliases).toEqual([]);
  });

  it('no expone secretos ni configuración operacional', () => {
    const context = contextFrom(makeCatalog());
    const serialized = serializeDiscoveryContext(context);
    for (const pattern of SECRET_OR_OPS_PATTERNS) {
      expect(serialized).not.toMatch(pattern);
    }
    expect(serialized).not.toContain('adapterId');
    expect(context.sources.harvested.every((source) => !('useFetchRelay' in source))).toBe(true);
  });

  it('es determinista para el mismo catálogo y reloj', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const first = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    const second = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    expect(second).toEqual(first);
    expect(serializeDiscoveryContext(second)).toBe(serializeDiscoveryContext(first));
  });

  it('genera un contexto válido con catálogo vacío', () => {
    const context = buildDiscoveryContext({
      catalog: emptyCatalog(),
      now: TEST_NOW,
      window: TEST_WINDOW,
    });

    expect(context.coveredEvents).toEqual([]);
    expect(context.sources.published).toEqual([]);
    expect(context.sources.harvested.map((source) => source.registryId).sort()).toEqual(
      [...SOURCE_REGISTRY.map((source) => source.id)].sort(),
    );
    expect(context.venues.length).toBeGreaterThan(0);
    expect(context.editorialScope.longTail).toContain('iglesias/parroquias');
    expect(context.evidenceInstructions.some((line) => line.includes('foundVia'))).toBe(true);
    expect(
      context.evidenceInstructions.some((line) => /programa, compositores u obras/i.test(line)),
    ).toBe(true);
    expect(parseDiscoveryContext(context).coveredEvents).toEqual([]);
  });

  it('parsea contra su propio schema', async () => {
    const catalog = await loadCatalogFromDir(fixtureCatalogDir);
    const context = buildDiscoveryContext({ catalog, now: TEST_NOW, window: TEST_WINDOW });
    const roundTrip = parseDiscoveryContext(JSON.parse(serializeDiscoveryContext(context)));
    expect(roundTrip).toEqual(context);
  });

  it('el alcance editorial es un resumen, no una copia de la Classification Policy', async () => {
    const policy = await readFile(path.join(import.meta.dirname, '..', 'docs', 'classification-policy.md'), 'utf8');
    const context = contextFrom(emptyCatalog());
    const scope = JSON.stringify(context.editorialScope);

    expect(context.editorialScope.music.precisionOverCoverage).toBe(true);
    expect(context.editorialScope.music.kinds.established.toLowerCase()).toMatch(/válido/);
    expect(context.editorialScope.music.kinds.alternative.toLowerCase()).toMatch(/válido/);
    expect(scope).not.toMatch(/1\. Eligibility/);
    expect(scope).not.toMatch(/Exclusiones decididas/);
    expect(scope).not.toMatch(/DJ \/ electrónica/);
    expect(scope.length).toBeLessThan(policy.length);
  });

  it('no presenta Clásica Madrid como agenda de toda la Comunidad', () => {
    const context = contextFrom(emptyCatalog());
    expect(context.editorialScope.geography.areas).toEqual(['madrid', 'nearby']);
    expect(context.editorialScope.geography.focus).toMatch(/Municipio de Madrid/);
    expect(context.editorialScope.geography.focus).toMatch(/nearby/);
    expect(context.editorialScope.geography.focus).toMatch(/No es una agenda de toda la Comunidad de Madrid/);
    expect(context.editorialScope.geography.focus.startsWith('Comunidad de Madrid')).toBe(false);
  });

  it('incluye un contrato de output derivado del schema de DiscoveryBatch', () => {
    const context = contextFrom(emptyCatalog());
    const eventSchema = (
      context.output.jsonSchema as {
        properties: {
          observations: { items: { properties: { event: { required?: string[] }; source: unknown } } };
        };
      }
    ).properties.observations.items.properties.event;

    expect(context.output.produces).toBe('DiscoveryBatch');
    expect(context.output.schemaVersion).toBe(1);
    expect(context.output.jsonSchema).toEqual(discoveryBatchJsonSchema());
    expect(context.output.sharedSourceHosts).toEqual([...SHARED_SOURCE_HOSTS]);
    expect(context.output.requiredObservedArrays).toEqual(['performers', 'composers', 'works']);
    expect(eventSchema.required).toEqual(expect.arrayContaining(['performers', 'composers', 'works', 'occurrences']));
    expect(context.output.forbiddenFields).toEqual(
      expect.arrayContaining(['eligibility', 'kind', 'eras', 'formats', 'slug', 'id']),
    );
    expect(JSON.stringify(context.output.jsonSchema)).not.toContain('eligibility');
    expect(JSON.stringify(context.output).length).toBeLessThan(12_000);

    const sample = parseDiscoveryBatch({
      schemaVersion: 1,
      observations: [
        {
          source: {
            url: 'https://www.parroquia.example/conciertos/bach',
            name: 'Parroquia de San José',
            homepage: 'https://www.parroquia.example/',
          },
          event: {
            title: 'Misa en Si menor',
            occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
            performers: [],
            composers: [{ name: 'Johann Sebastian Bach' }],
            works: [{ title: 'Misa en Si menor', composerName: 'Johann Sebastian Bach' }],
          },
        },
      ],
    });
    expect(sample.schemaVersion).toBe(context.output.schemaVersion);
  });
});

describe('parseDiscoveryContextArgs', () => {
  it('acepta --from/--to, --output y --data-dir', () => {
    expect(
      parseDiscoveryContextArgs([
        '--from',
        '2026-09-01',
        '--to',
        '2027-01-01',
        '--output',
        'ingestion/work/discovery-context.json',
        '--data-dir',
        'tmp/data',
      ]),
    ).toEqual({
      ok: true,
      window: { from: '2026-09-01', to: '2027-01-01' },
      outputPath: 'ingestion/work/discovery-context.json',
      dataDir: 'tmp/data',
    });
  });

  it('sin fechas deja la ventana al default del caller', () => {
    expect(parseDiscoveryContextArgs(['--output', 'out.json'])).toEqual({
      ok: true,
      outputPath: 'out.json',
    });
  });

  it('exige --from y --to juntos y rechaza flags desconocidas', () => {
    const missing = parseDiscoveryContextArgs(['--from', '2026-09-01']);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/juntos/);

    const unknown = parseDiscoveryContextArgs(['--dry-run']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toMatch(/flag desconocida: --dry-run/);

    const positional = parseDiscoveryContextArgs(['lote.json']);
    expect(positional.ok).toBe(false);
  });
});
