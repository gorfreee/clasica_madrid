import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { blogLastmodsFromDirectory, readBlogSitemapPost, readFrontmatter } from '../src/lib/blog/files.ts';
import { blogEntrySchema, calendarIso } from '../src/lib/blog/schema.ts';
import { headerNavigation } from '../src/lib/presentation/nav.ts';
import {
  articleCtaModel,
  blogLastmodMap,
  buildBlogIndexModel,
  relatedArticles,
  tocTree,
  type BlogPostMeta,
} from '../src/lib/presentation/blog.ts';
import { relatedVenueCard, upcomingEventsForArticle } from '../src/lib/presentation/blog-catalog.ts';
import { assertKnownRelatedVenues } from '../src/lib/presentation/blog.ts';
import { buildBlogPostingJsonLd } from '../src/lib/presentation/json-ld.ts';
import { blogPostPath, blogPostUrl, publicUrl } from '../src/lib/presentation/urls.ts';
import { assertYouTubeId, youtubeEmbedUrl, youtubeWatchUrl } from '../src/lib/presentation/youtube.ts';
import { makeCatalog, makeEvent, makeVenue, testClock } from './helpers.ts';

const schema = blogEntrySchema(z.string().min(1));
const root = path.join(import.meta.dirname, '..');
const fixturePath = path.join(root, 'src/content/blog/fixture-sistema-editorial.mdx');

function entry(overrides: Partial<BlogPostMeta> = {}): BlogPostMeta {
  return {
    id: 'pieza',
    title: 'Pieza',
    description: 'Descripción de prueba',
    publishedAt: '2026-05-01',
    kind: 'guia',
    tags: [],
    relatedVenues: [],
    featured: false,
    draft: false,
    ...overrides,
  };
}

function validFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Título',
    description: 'Una entradilla válida.',
    publishedAt: '2026-09-01T00:00:00.000Z',
    kind: 'guia',
    heroImage: 'hero.png',
    heroAlt: 'Imagen de prueba',
    ...overrides,
  };
}

describe('schema del blog', () => {
  it('normaliza la fecha UTC de medianoche y aplica los valores por defecto', () => {
    const parsed = schema.parse(validFrontmatter());
    expect(parsed.publishedAt).toBe('2026-09-01');
    expect(parsed.draft).toBe(false);
    expect(parsed.featured).toBe(false);
    expect(parsed.tags).toEqual([]);
    expect(parsed.relatedVenues).toEqual([]);
    expect(calendarIso(new Date('2026-03-04T00:00:00.000Z'))).toBe('2026-03-04');
  });

  it('rechaza kind, fechas, créditos y claves desconocidas', () => {
    expect(() => schema.parse(validFrontmatter({ kind: 'ensayo' }))).toThrow();
    expect(() => schema.parse(validFrontmatter({ title: '  ' }))).toThrow();
    expect(() =>
      schema.parse(validFrontmatter({ publishedAt: '2026-09-01', updatedAt: '2026-08-01' })),
    ).toThrow(/updatedAt/);
    expect(() => schema.parse(validFrontmatter({ heroCreditUrl: 'https://example.org/foto' }))).toThrow(
      /heroCredit/,
    );
    expect(() => schema.parse(validFrontmatter({ tags: ['Sala', 'sala'] }))).toThrow(/tags/);
    expect(() => schema.parse(validFrontmatter({ extra: true }))).toThrow();
    expect(calendarIso('2026-09-01T22:00:00.000Z')).toBeNull();
  });
});

describe('publicación y orden', () => {
  const posts = [
    entry({ id: 'borrador', draft: true, featured: true, publishedAt: '2026-09-20', title: 'No publicar' }),
    entry({ id: 'viejo', publishedAt: '2026-01-02' }),
    entry({ id: 'nuevo', featured: true, publishedAt: '2026-03-01', kind: 'temporada' }),
    entry({ id: 'medio', publishedAt: '2026-02-01' }),
  ];

  it('excluye borradores, destaca el publicado más reciente y ordena el resto', () => {
    const index = buildBlogIndexModel(posts);
    expect(index.canonicalPath).toBe('/blog/');
    expect(index.isEmpty).toBe(false);
    expect(index.featured?.id).toBe('nuevo');
    expect(index.featured?.href).toBe('/blog/nuevo/');
    expect(index.featured?.kindLabel).toBe('Temporada');
    expect(index.posts.map((post) => post.id)).toEqual(['medio', 'viejo']);
    expect(JSON.stringify(index)).not.toContain('No publicar');
    expect(buildBlogIndexModel([entry({ draft: true })])).toMatchObject({
      isEmpty: true,
      featured: null,
      posts: [],
    });
  });

  it('relaciona por lugar, etiqueta y tipo, sin borradores', () => {
    const current = entry({
      id: 'actual',
      kind: 'guia',
      tags: ['organo'],
      relatedVenues: ['teatro-real'],
      publishedAt: '2026-06-01',
    });
    const ranked = relatedArticles(
      [
        current,
        entry({ id: 'mismo-lugar', relatedVenues: ['teatro-real'], publishedAt: '2026-04-01' }),
        entry({ id: 'misma-etiqueta', tags: ['organo'], publishedAt: '2026-05-01' }),
        entry({ id: 'mismo-tipo', kind: 'guia', publishedAt: '2026-07-01' }),
        entry({ id: 'nada', kind: 'critica', publishedAt: '2026-08-01' }),
        entry({ id: 'oculto', draft: true, relatedVenues: ['teatro-real'], publishedAt: '2026-08-02' }),
      ],
      'actual',
    );
    expect(ranked.map((post) => post.id)).toEqual(['mismo-lugar', 'misma-etiqueta', 'mismo-tipo']);
    expect(relatedArticles(posts, 'borrador')).toEqual([]);
  });

  it('no fabrica un índice con un solo apartado', () => {
    expect(tocTree([{ depth: 2, slug: 'solo', text: 'Solo' }])).toEqual([]);
    expect(
      tocTree([
        { depth: 2, slug: 'uno', text: 'Uno' },
        { depth: 3, slug: 'detalle', text: 'Detalle' },
        { depth: 2, slug: 'dos', text: 'Dos' },
        { depth: 4, slug: 'fino', text: 'Fino' },
      ]),
    ).toEqual([
      { slug: 'uno', text: 'Uno', children: [{ slug: 'detalle', text: 'Detalle' }] },
      { slug: 'dos', text: 'Dos', children: [] },
    ]);
  });
});

describe('rutas, sitemap y JSON-LD', () => {
  it('canoniza /blog/ y /blog/{slug}/ con barra final', () => {
    expect(blogPostPath('temporada-del-real')).toBe('/blog/temporada-del-real/');
    expect(blogPostUrl('temporada-del-real')).toBe('https://clasicamadrid.com/blog/temporada-del-real/');
    expect(publicUrl('/blog')).toBe('https://clasicamadrid.com/blog/');
    const blog = headerNavigation('/blog/cualquier-articulo/');
    expect(blog.moreCurrent).toBe(true);
    expect(blog.secondaryLinks[0]?.current).toBe(true);
  });

  it('usa updatedAt como lastmod y deja fuera los borradores', () => {
    const map = blogLastmodMap([
      { id: 'publicado', draft: false, publishedAt: '2026-01-01', updatedAt: '2026-04-02' },
      { id: 'sin-revision', draft: false, publishedAt: '2026-03-03' },
      { id: 'borrador', draft: true, publishedAt: '2026-08-01', updatedAt: '2026-08-02' },
    ]);
    expect(map.get('/blog/publicado/')).toBe('2026-04-02');
    expect(map.get('/blog/sin-revision/')).toBe('2026-03-03');
    expect(map.get('/blog/')).toBe('2026-04-02');
    expect(map.has('/blog/borrador/')).toBe(false);
  });

  it('describe BlogPosting y las migas, sin schemas que el texto no sostiene', () => {
    const jsonLd = buildBlogPostingJsonLd({
      title: 'Una guía',
      description: 'Entradilla',
      path: '/blog/una-guia/',
      publishedAt: '2026-02-02',
      updatedAt: '2026-02-10',
      image: '/_astro/hero.jpg',
    });
    expect(jsonLd[0]).toMatchObject({
      '@type': 'BlogPosting',
      headline: 'Una guía',
      description: 'Entradilla',
      url: 'https://clasicamadrid.com/blog/una-guia/',
      datePublished: '2026-02-02',
      dateModified: '2026-02-10',
      image: ['https://clasicamadrid.com/_astro/hero.jpg'],
      author: { '@type': 'Organization', name: 'Clásica Madrid', url: 'https://clasicamadrid.com/acerca-de/' },
      publisher: { '@type': 'Organization', name: 'Clásica Madrid' },
    });
    expect(jsonLd[0]).toMatchObject({
      mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://clasicamadrid.com/blog/una-guia/' },
    });
    expect(jsonLd[1]).toMatchObject({ '@type': 'BreadcrumbList' });
    const serialized = JSON.stringify(jsonLd);
    expect(serialized).not.toContain('FAQPage');
    expect(serialized).not.toContain('VideoObject');
    expect(buildBlogIndexModel([]).jsonLd.map((item) => item['@type'])).toEqual([
      'CollectionPage',
      'BreadcrumbList',
    ]);
  });
});

describe('catálogo dentro del artículo', () => {
  it('lista solo conciertos futuros del lugar y degrada si no hay', () => {
    const room = makeVenue({
      id: 'ven_auditorio_sala',
      slug: 'auditorio-nacional-sala',
      name: 'Sala de prueba',
      parentVenueId: 'ven_auditorio_nacional',
    });
    const catalog = makeCatalog({
      venues: [makeVenue(), room],
      events: [
        makeEvent({ venueId: 'ven_auditorio_sala' }),
        makeEvent({
          id: 'evt_pasado',
          slug: 'ya-sonado',
          title: 'Ya sonado',
          occurrences: [{ id: 'occ_pasado', date: '2026-08-01', time: '19:00', status: 'scheduled' }],
        }),
      ],
    });
    const upcoming = upcomingEventsForArticle(catalog, { venueSlug: 'auditorio-nacional', limit: 6 }, testClock);
    expect(upcoming.items.map((item) => item.eventSlug)).toEqual(['matinees-de-otono']);
    expect(upcoming.items[0]?.href).toBe('/eventos/matinees-de-otono/');
    expect(upcoming.heading).toContain('Auditorio Nacional de Música');
    expect(
      upcomingEventsForArticle(catalog, { venueSlug: 'auditorio-nacional-sala', limit: 6 }, testClock).items,
    ).toHaveLength(1);
    expect(upcomingEventsForArticle(catalog, { venueSlug: 'auditorio-nacional', limit: 20 }, testClock).items).toHaveLength(1);
    const empty = upcomingEventsForArticle(
      makeCatalog({ events: [] }),
      { venueSlug: 'auditorio-nacional' },
      testClock,
    );
    expect(empty.items).toEqual([]);
    expect(empty.emptyLabel).toMatch(/No hay conciertos próximos/);
    expect(() => upcomingEventsForArticle(catalog, { venueSlug: 'no-existe' }, testClock)).toThrow(/no-existe/);
  });

  it('enlaza la ficha del lugar y rechaza un slug desconocido', () => {
    const card = relatedVenueCard(makeCatalog(), 'auditorio-nacional', testClock);
    expect(card).toMatchObject({
      name: 'Auditorio Nacional de Música',
      href: '/lugares/auditorio-nacional/',
    });
    expect(card.summary).toMatch(/1 concierto próximo/);
    expect(() => relatedVenueCard(makeCatalog(), 'no-existe', testClock)).toThrow(/no-existe/);
    expect(() =>
      assertKnownRelatedVenues([{ id: 'pieza', venues: ['auditorio-nacional', 'fantasma'] }], new Set(['auditorio-nacional'])),
    ).toThrow(/fantasma/);
  });
});

describe('llamadas y vídeo', () => {
  it('resuelve WhatsApp, la agenda y un enlace interno', () => {
    expect(articleCtaModel({ kind: 'whatsapp' })).toMatchObject({
      whatsapp: true,
      external: true,
      href: 'https://whatsapp.com/channel/0029VbDMlLw5Ejy6w8hyme2J',
    });
    expect(articleCtaModel({ kind: 'agenda' }).href).toBe('/');
    expect(articleCtaModel({ kind: 'internal', href: '/lugares/teatro-real', title: 'Teatro Real' }).href).toBe(
      '/lugares/teatro-real/',
    );
    expect(() => articleCtaModel({ kind: 'internal', href: 'https://example.org', title: 'Fuera' })).toThrow();
  });

  it('no monta el iframe hasta tener un id válido y usa el dominio sin cookies', () => {
    expect(youtubeEmbedUrl('M7lc1UVf-VE')).toBe(
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=1',
    );
    expect(youtubeWatchUrl('M7lc1UVf-VE')).toContain('youtube-nocookie.com/watch?v=');
    expect(() => assertYouTubeId('corto')).toThrow();
    expect(() => assertYouTubeId('malicioso"><iframe')).toThrow();
  });
});

describe('fixture en borrador', () => {
  const source = readFileSync(fixturePath, 'utf8');

  it('permanece en draft y no aporta lastmod', () => {
    expect(source).toMatch(/^draft:\s*true\s*$/m);
    expect(readFrontmatter(source)).toMatchObject({
      draft: true,
      featured: true,
      kind: 'guia',
      relatedVenues: ['teatro-real'],
    });
    expect(readBlogSitemapPost(source, 'fixture-sistema-editorial')).toMatchObject({
      draft: true,
      publishedAt: '2026-09-01',
      updatedAt: '2026-09-20',
    });
    const map = blogLastmodsFromDirectory(path.join(root, 'src/content/blog'));
    expect([...map.keys()]).not.toContain('/blog/fixture-sistema-editorial/');
    expect(map.get('/blog/')).toBe('2026-09-25');
    expect(map.get('/blog/temporada-teatro-real-2026-2027/')).toBe('2026-09-25');
  });

  it('lee un artículo publicado desde un directorio y usa su updatedAt', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blog-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'publicado.mdx'),
      `---
title: "Publicado"
publishedAt: 2026-01-01
updatedAt: 2026-06-06
draft: false
---
Texto
`,
    );
    writeFileSync(
      path.join(dir, 'oculto.mdx'),
      `---
title: "Oculto"
publishedAt: 2026-07-01
draft: true
---
Texto
`,
    );
    const map = blogLastmodsFromDirectory(dir);
    expect(map.get('/blog/publicado/')).toBe('2026-06-06');
    expect(map.get('/blog/')).toBe('2026-06-06');
    expect(map.has('/blog/oculto/')).toBe(false);
  });
});
