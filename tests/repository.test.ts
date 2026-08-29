import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPublishedCatalogCache,
  loadCatalogFromDir,
  loadPublishedCatalog,
} from '../src/lib/repository/load.ts';

const fixtureDir = path.resolve('tests/fixtures/rich');

describe('carga del catálogo', () => {
  afterEach(() => {
    clearPublishedCatalogCache();
  });

  it('memoiza el catálogo publicado en el mismo proceso', async () => {
    clearPublishedCatalogCache();
    const first = await loadPublishedCatalog();
    const second = await loadPublishedCatalog();
    expect(second).toBe(first);
    clearPublishedCatalogCache();
    const third = await loadPublishedCatalog();
    expect(third).not.toBe(first);
    expect(third.events.length).toBe(first.events.length);
  });

  it('carga un directorio explícito sin reutilizar la caché publicada', async () => {
    const published = await loadPublishedCatalog();
    const fixture = await loadCatalogFromDir(fixtureDir);
    expect(fixture).not.toBe(published);
    expect(fixture.events.length).toBeGreaterThan(0);
    const again = await loadCatalogFromDir(fixtureDir);
    expect(again).not.toBe(fixture);
    expect(again.events.map((event) => event.id).sort()).toEqual(
      fixture.events.map((event) => event.id).sort(),
    );
  });
});
