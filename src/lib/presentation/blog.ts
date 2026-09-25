import { fromMadridLocal, MADRID_TIME_ZONE } from '../domain/dates.ts';
import { WHATSAPP_CHANNEL_URL, SITE_NAME } from './constants.ts';
import { buildCollectionPageJsonLd } from './json-ld.ts';
import {
  assertBlogSlug,
  blogKindLabels,
  type BlogKind,
} from '../blog/schema.ts';
import { AGENDA_PATH, BLOG_PATH, blogPostPath, publicPath } from './urls.ts';

export { assertBlogSlug, blogKindLabels };
export type { BlogKind };

export const BLOG_DOCUMENT_TITLE = 'Blog de música clásica en Madrid';
export const BLOG_DESCRIPTION =
  'Temporadas, salas, ciclos y guías para seguir la música clásica en Madrid.';
export const BLOG_HEADING = 'Historias para escuchar Madrid';
export const BLOG_LEDE = 'Temporadas, salas, ciclos y guías de la música clásica en Madrid.';
export const BLOG_AUTHOR_NAME = SITE_NAME;

export type BlogPostMeta = {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt?: string;
  kind: BlogKind;
  tags: readonly string[];
  relatedVenues: readonly string[];
  featured: boolean;
  draft: boolean;
};

export type BlogIndexCard = {
  id: string;
  href: string;
  title: string;
  description: string;
  kind: BlogKind;
  kindLabel: string;
  publishedAt: string;
  publishedLabel: string;
};

export type BlogIndexModel = {
  title: string;
  description: string;
  canonicalPath: string;
  heading: string;
  lede: string;
  featured: BlogIndexCard | null;
  posts: BlogIndexCard[];
  isEmpty: boolean;
  jsonLd: Record<string, unknown>[];
};

export type BlogSitemapPost = {
  id: string;
  draft: boolean;
  publishedAt: string;
  updatedAt?: string;
};

export type TocHeading = {
  depth: number;
  slug: string;
  text: string;
};

export type TocItem = {
  slug: string;
  text: string;
  children: { slug: string; text: string }[];
};

type BlogEntryData = {
  title: string;
  description: string;
  publishedAt: string;
  updatedAt?: string;
  kind: BlogKind;
  tags: readonly string[];
  relatedVenues: readonly string[];
  featured: boolean;
  draft: boolean;
};

export function toBlogPostMeta(entry: { id: string; data: BlogEntryData }): BlogPostMeta {
  return {
    id: entry.id,
    title: entry.data.title,
    description: entry.data.description,
    publishedAt: entry.data.publishedAt,
    updatedAt: entry.data.updatedAt,
    kind: entry.data.kind,
    tags: entry.data.tags,
    relatedVenues: entry.data.relatedVenues,
    featured: entry.data.featured,
    draft: entry.data.draft,
  };
}

export function isPublishedBlogPost(post: { draft: boolean }): boolean {
  return post.draft !== true;
}

export function publishedBlogPosts(posts: readonly BlogPostMeta[]): BlogPostMeta[] {
  return posts.filter(isPublishedBlogPost).sort(compareBlogPosts);
}

export function buildBlogIndexModel(posts: readonly BlogPostMeta[]): BlogIndexModel {
  const published = publishedBlogPosts(posts);
  const featured = published.find((post) => post.featured) ?? null;
  const rest = featured ? published.filter((post) => post.id !== featured.id) : published;
  return {
    title: BLOG_DOCUMENT_TITLE,
    description: BLOG_DESCRIPTION,
    canonicalPath: BLOG_PATH,
    heading: BLOG_HEADING,
    lede: BLOG_LEDE,
    featured: featured ? toCard(featured) : null,
    posts: rest.map(toCard),
    isEmpty: published.length === 0,
    jsonLd: buildCollectionPageJsonLd({
      name: 'Blog',
      description: BLOG_DESCRIPTION,
      path: BLOG_PATH,
    }),
  };
}

/** Newest published date wins. Drafts never receive a URL or a lastmod. */
export function blogLastmodMap(posts: readonly BlogSitemapPost[]): Map<string, string> {
  const map = new Map<string, string>();
  let latest: string | undefined;
  for (const post of posts) {
    if (!isPublishedBlogPost(post)) continue;
    assertBlogSlug(post.id);
    const lastmod = post.updatedAt ?? post.publishedAt;
    map.set(blogPostPath(post.id), lastmod);
    if (!latest || lastmod > latest) latest = lastmod;
  }
  if (latest) map.set(BLOG_PATH, latest);
  return map;
}

/**
 * Deterministic related posts. Shared venues weigh more than tags, and the
 * same kind is only a tie-breaker. Drafts and the current article are out.
 */
export function relatedArticles(
  posts: readonly BlogPostMeta[],
  currentId: string,
  limit = 3,
): BlogPostMeta[] {
  const current = posts.find((post) => post.id === currentId);
  if (!current || !isPublishedBlogPost(current)) return [];
  const ranked = publishedBlogPosts(posts)
    .filter((post) => post.id !== currentId)
    .map((post) => ({ post, score: relatedScore(current, post) }))
    .filter((item) => item.score > 0);
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return compareBlogPosts(left.post, right.post);
  });
  return ranked.slice(0, Math.max(0, limit)).map((item) => item.post);
}

/** At least two H2s. A single section does not get an index. */
export function tocTree(headings: readonly TocHeading[]): TocItem[] {
  const sections = headings.filter((heading) => heading.depth === 2);
  if (sections.length < 2) return [];
  const tree: TocItem[] = [];
  for (const heading of headings) {
    if (heading.depth === 1 || heading.depth > 3) continue;
    if (heading.depth === 2) {
      tree.push({ slug: heading.slug, text: heading.text, children: [] });
      continue;
    }
    tree.at(-1)?.children.push({ slug: heading.slug, text: heading.text });
  }
  return tree;
}

export function formatBlogDate(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: MADRID_TIME_ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(fromMadridLocal(isoDate, '12:00'));
}

export function assertKnownRelatedVenues(
  posts: readonly { id: string; venues: readonly string[] }[],
  knownSlugs: ReadonlySet<string>,
): void {
  const problems: string[] = [];
  for (const post of posts) {
    const missing = post.venues.filter((slug) => !knownSlugs.has(slug));
    if (missing.length > 0) problems.push(`${post.id}: ${missing.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(`Artículos con lugares que no están en el catálogo:\n${problems.join('\n')}`);
  }
}

export type ArticleCtaKind = 'whatsapp' | 'agenda' | 'internal';

export type ArticleCtaModel = {
  href: string;
  title: string;
  text?: string;
  linkLabel: string;
  kicker: string;
  external: boolean;
  whatsapp: boolean;
};

export function articleCtaModel(input: {
  kind: ArticleCtaKind;
  href?: string;
  title?: string;
  text?: string;
}): ArticleCtaModel {
  const text = input.text?.trim() || undefined;
  if (input.kind === 'whatsapp') {
    return {
      href: WHATSAPP_CHANNEL_URL,
      title: input.title?.trim() || 'Sigue Clásica Madrid en WhatsApp',
      text: text ?? 'Conciertos, novedades y selecciones de la agenda.',
      linkLabel: 'Seguir el canal',
      kicker: 'WhatsApp',
      external: true,
      whatsapp: true,
    };
  }
  if (input.kind === 'agenda') {
    return {
      href: AGENDA_PATH,
      title: input.title?.trim() || 'Ver los conciertos',
      text,
      linkLabel: 'Ir a la agenda',
      kicker: 'Agenda',
      external: false,
      whatsapp: false,
    };
  }
  const href = input.href?.trim() ?? '';
  if (!href.startsWith('/') || href.startsWith('//')) {
    throw new Error('ArticleCTA internal exige un href que empiece por /');
  }
  const title = input.title?.trim();
  if (!title) throw new Error('ArticleCTA internal exige title');
  return {
    href: publicPath(href),
    title,
    text,
    linkLabel: title,
    kicker: 'En Clásica Madrid',
    external: false,
    whatsapp: false,
  };
}

function toCard(post: BlogPostMeta): BlogIndexCard {
  return {
    id: post.id,
    href: blogPostPath(post.id),
    title: post.title,
    description: post.description,
    kind: post.kind,
    kindLabel: blogKindLabels[post.kind],
    publishedAt: post.publishedAt,
    publishedLabel: formatBlogDate(post.publishedAt),
  };
}

function compareBlogPosts(left: BlogPostMeta, right: BlogPostMeta): number {
  if (left.publishedAt !== right.publishedAt) return right.publishedAt.localeCompare(left.publishedAt);
  return left.id.localeCompare(right.id, 'es');
}

function relatedScore(current: BlogPostMeta, other: BlogPostMeta): number {
  const venues = overlap(current.relatedVenues, other.relatedVenues);
  const tags = overlap(
    current.tags.map((tag) => tag.toLocaleLowerCase('es')),
    other.tags.map((tag) => tag.toLocaleLowerCase('es')),
  );
  const kind = current.kind === other.kind ? 1 : 0;
  return venues * 3 + tags * 2 + kind;
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const set = new Set(right);
  let count = 0;
  for (const value of new Set(left)) {
    if (set.has(value)) count += 1;
  }
  return count;
}
