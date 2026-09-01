import { describe, expect, it } from 'vitest';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { sitemapLastmodMap, sitemapPageFilter } from '../src/lib/presentation/sitemap.ts';
import { eventPath, publicPath, publicUrl, venuePath } from '../src/lib/presentation/urls.ts';
import { buildVenuePageModel, buildVenuesIndexModel } from '../src/lib/presentation/venue.ts';
import { richCatalog, testClock } from './helpers.ts';

function musicEvents(jsonLd: Record<string, unknown>[]) {
  return jsonLd.filter((item) => item['@type'] === 'MusicEvent');
}

describe('URLs públicas', () => {
  it('normaliza rutas con barra final', () => {
    expect(publicPath('/')).toBe('/');
    expect(publicPath('/lugares')).toBe('/lugares/');
    expect(publicPath('/lugares/')).toBe('/lugares/');
    expect(eventPath('carmen')).toBe('/eventos/carmen/');
    expect(venuePath('auditorio-nacional')).toBe('/lugares/auditorio-nacional/');
    expect(publicUrl('/eventos/carmen')).toBe('https://clasicamadrid.com/eventos/carmen/');
  });
});

describe('títulos y canonicals de ficha', () => {
  it('incluye el lugar en el title de documento sin cambiar el h1', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(page?.title).toBe('Carmen');
    expect(page?.documentTitle).toBe('Carmen · Auditorio Nacional de Música');
    expect(page?.canonicalPath).toBe('/eventos/carmen/');
    expect(page?.venueHref).toBe('/lugares/auditorio-nacional/');
    expect(page?.description).toContain('Ópera');
  });

  it('añade entrada gratuita a la description cuando aplica', () => {
    const page = buildEventPageModel(richCatalog(), 'recital-de-organo', testClock);
    expect(page?.description).toContain('Entrada gratuita');
    expect(page?.description).toContain('Órgano');
  });

  it('el índice de lugares canoniciza con barra final', () => {
    const index = buildVenuesIndexModel(richCatalog(), testClock);
    expect(index.canonicalPath).toBe('/lugares/');
    expect(index.title).toContain('Madrid');
  });
});

describe('JSON-LD de presentación', () => {
  it('añade @id, description, offers y Person para solistas', () => {
    const page = buildEventPageModel(richCatalog(), 'recital-de-organo', testClock);
    const [event] = musicEvents(page?.jsonLd ?? []);
    expect(event?.['@id']).toBe('https://clasicamadrid.com/eventos/recital-de-organo/#occ_organo_1');
    expect(event?.url).toBe('https://clasicamadrid.com/eventos/recital-de-organo/');
    expect(event?.description).toMatch(/Órgano/);
    expect(event?.description).toMatch(/Ana Ruiz/);
    expect(event?.isAccessibleForFree).toBe(true);
    expect(event?.offers).toMatchObject({
      '@type': 'Offer',
      url: 'https://example.org/san-manuel/organo',
      price: 0,
      priceCurrency: 'EUR',
    });
    expect(event?.performer).toEqual([{ '@type': 'Person', name: 'Ana Ruiz' }]);
    expect(page?.jsonLd.some((item) => item['@type'] === 'BreadcrumbList')).toBe(true);
  });

  it('tipa orquesta y coro como PerformingGroup y enlaza la oferta oficial', () => {
    const page = buildEventPageModel(richCatalog(), 'carmen', testClock);
    const [event] = musicEvents(page?.jsonLd ?? []);
    expect(event?.performer).toEqual([
      { '@type': 'PerformingGroup', name: 'Coro del Teatro' },
      { '@type': 'PerformingGroup', name: 'Orquesta titular' },
    ]);
    expect(event?.offers).toEqual({
      '@type': 'Offer',
      url: 'https://www.auditorionacional.mcu.es/eventos/carmen',
    });
  });

  it('describe el lugar con MusicVenue y migas', () => {
    const page = buildVenuePageModel(richCatalog(), 'auditorio-nacional', testClock);
    expect(page?.jsonLd[0]).toMatchObject({
      '@type': 'MusicVenue',
      name: 'Auditorio Nacional de Música',
      url: 'https://clasicamadrid.com/lugares/auditorio-nacional/',
      sameAs: 'https://www.auditorionacional.mcu.es/',
    });
    expect(page?.jsonLd[1]?.['@type']).toBe('BreadcrumbList');
  });

  it('describe el sitio en la agenda', () => {
    const page = buildAgendaPageModel(richCatalog(), new URL('https://clasicamadrid.com/'), testClock);
    expect(page.jsonLd[0]).toMatchObject({
      '@type': 'WebSite',
      name: 'Clásica Madrid',
      url: 'https://clasicamadrid.com/',
    });
  });
});

describe('sitemap', () => {
  it('excluye la URL de 404', () => {
    expect(sitemapPageFilter('https://clasicamadrid.com/404')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/')).toBe(true);
  });

  it('añade lastmod a partir de lastVerifiedAt', () => {
    const map = sitemapLastmodMap(richCatalog());
    expect(map.get('/eventos/carmen/')).toBe('2026-08-20');
    expect(map.get('/')).toBe('2026-08-21');
    expect(map.get('/lugares/auditorio-nacional/')).toBe('2026-08-20');
  });
});
