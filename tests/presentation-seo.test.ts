import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgendaPageModel } from '../src/lib/presentation/agenda.ts';
import {
  BRAND_BLUE,
  DEFAULT_SOCIAL_IMAGE_ALT,
  DEFAULT_SOCIAL_IMAGE_PATH,
  SITE_BACKGROUND,
} from '../src/lib/presentation/constants.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { buildSocialImageMetadata } from '../src/lib/presentation/social.ts';
import { sitemapLastmodMap, sitemapPageFilter } from '../src/lib/presentation/sitemap.ts';
import {
  eventPath,
  publicAssetUrl,
  publicPath,
  publicUrl,
  venuePath,
} from '../src/lib/presentation/urls.ts';
import { buildVenuePageModel, buildVenuesIndexModel } from '../src/lib/presentation/venue.ts';
import { richCatalog, testClock } from './helpers.ts';

function musicEvents(jsonLd: Record<string, unknown>[]) {
  return jsonLd.filter((item) => item['@type'] === 'MusicEvent');
}

const publicDir = path.join(import.meta.dirname, '..', 'public');

function pngDimensions(relativePath: string): { width: number; height: number } {
  const png = readFileSync(path.join(publicDir, relativePath));
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('URLs públicas', () => {
  it('normaliza rutas con barra final', () => {
    expect(publicPath('/')).toBe('/');
    expect(publicPath('/lugares')).toBe('/lugares/');
    expect(publicPath('/lugares/')).toBe('/lugares/');
    expect(eventPath('carmen')).toBe('/eventos/carmen/');
    expect(venuePath('auditorio-nacional')).toBe('/lugares/auditorio-nacional/');
    expect(publicUrl('/eventos/carmen')).toBe('https://clasicamadrid.com/eventos/carmen/');
    expect(publicAssetUrl('/brand/card.png')).toBe('https://clasicamadrid.com/brand/card.png');
  });
});

describe('social sharing e identidad', () => {
  it('usa por defecto la social card global con URL pública absoluta', () => {
    expect(buildSocialImageMetadata()).toEqual({
      url: `https://clasicamadrid.com${DEFAULT_SOCIAL_IMAGE_PATH}`,
      alt: DEFAULT_SOCIAL_IMAGE_ALT,
    });
  });

  it('respeta una socialImage alternativa y la convierte en URL pública absoluta', () => {
    expect(buildSocialImageMetadata('/brand/evento-especial.png', 'Evento especial')).toEqual({
      url: 'https://clasicamadrid.com/brand/evento-especial.png',
      alt: 'Evento especial',
    });
  });

  it('publica el manifest mínimo con colores e iconos reales', () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'site.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'Clásica Madrid',
      short_name: 'Clásica Madrid',
      start_url: '/',
      scope: '/',
      display: 'browser',
      theme_color: BRAND_BLUE,
      background_color: SITE_BACKGROUND,
    });
    expect(manifest.icons).toEqual([
      { src: '/brand/clasica-madrid-icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/clasica-madrid-icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('mantiene las dimensiones requeridas de todos los PNG declarados', () => {
    expect(pngDimensions('brand/clasica-madrid-social-card.png')).toEqual({
      width: 1200,
      height: 630,
    });
    expect(pngDimensions('apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    expect(pngDimensions('brand/clasica-madrid-icon-192.png')).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngDimensions('brand/clasica-madrid-icon-512.png')).toEqual({
      width: 512,
      height: 512,
    });
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
  it('excluye la URL de 404 y la agenda completa interna', () => {
    expect(sitemapPageFilter('https://clasicamadrid.com/404')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/_agenda/completa/')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/')).toBe(true);
  });

  it('añade lastmod a partir de lastVerifiedAt', () => {
    const map = sitemapLastmodMap(richCatalog());
    expect(map.get('/eventos/carmen/')).toBe('2026-08-20');
    expect(map.get('/')).toBe('2026-08-21');
    expect(map.get('/lugares/auditorio-nacional/')).toBe('2026-08-20');
  });

  it('incluye lastmod del slug histórico de un evento consolidado', () => {
    const catalog = richCatalog();
    catalog.events[0] = { ...catalog.events[0]!, slugAliases: ['carmen-antigua'] };
    const map = sitemapLastmodMap(catalog);
    expect(map.get('/eventos/carmen-antigua/')).toBe(catalog.events[0]?.lastVerifiedAt);
  });
});
