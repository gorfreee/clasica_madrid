import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blogLastmodMap, type BlogSitemapPost } from '../presentation/blog.ts';
import { calendarIso } from './schema.ts';

/** Flat `src/content/blog/{slug}.mdx` files. Subfolders are rejected on purpose. */
export function blogContentDir(): string {
  return fileURLToPath(new URL('../../content/blog/', import.meta.url));
}

/**
 * Lastmod for the sitemap integration. Reads the files directly so it does
 * not depend on the `astro:content` virtual module, which is not available
 * while `astro.config.ts` is loading.
 */
export function blogLastmodsFromDirectory(dir: string): Map<string, string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const posts: BlogSitemapPost[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      throw new Error(`Los artículos del blog van sueltos en content/blog, no en «${entry.name}»`);
    }
    if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) continue;
    const id = entry.name.replace(/\.mdx?$/, '');
    const source = readFileSync(path.join(dir, entry.name), 'utf8');
    posts.push(readBlogSitemapPost(source, id));
  }
  return blogLastmodMap(posts);
}

export function readBlogSitemapPost(source: string, id: string): BlogSitemapPost {
  const data = readFrontmatter(source);
  const publishedAt = calendarIso(data.publishedAt);
  if (!publishedAt) {
    throw new Error(`${id}: publishedAt debe ser una fecha YYYY-MM-DD`);
  }
  const hasUpdated = data.updatedAt != null && data.updatedAt !== '';
  const updatedAt = hasUpdated ? calendarIso(data.updatedAt) : undefined;
  if (hasUpdated && !updatedAt) {
    throw new Error(`${id}: updatedAt debe ser una fecha YYYY-MM-DD`);
  }
  if (updatedAt && updatedAt < publishedAt) {
    throw new Error(`${id}: updatedAt es anterior a publishedAt`);
  }
  if (data.draft != null && data.draft !== true && data.draft !== false) {
    throw new Error(`${id}: draft debe ser true o false`);
  }
  return { id, draft: data.draft === true, publishedAt, updatedAt: updatedAt ?? undefined };
}

export function readFrontmatter(source: string): Record<string, unknown> {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('El artículo no abre el frontmatter con ---');
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) throw new Error('El frontmatter no está cerrado');
  return parseBlock(normalized.slice(4, end));
}

function parseBlock(block: string): Record<string, unknown> {
  const lines = block.split('\n');
  const data: Record<string, unknown> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`No se pudo leer el frontmatter: ${line}`);
    const key = match[1]!;
    const rest = (match[2] ?? '').trim();
    if (rest === '[]') {
      data[key] = [];
      index += 1;
      continue;
    }
    if (rest === '' || rest === '|' || rest === '>') {
      const nested = readNested(lines, index + 1, rest);
      data[key] = nested.value;
      index = nested.next;
      continue;
    }
    data[key] = parseScalar(rest);
    index += 1;
  }
  return data;
}

function readNested(
  lines: readonly string[],
  start: number,
  mode: string,
): { value: unknown; next: number } {
  if (mode === '|' || mode === '>') {
    const parts: string[] = [];
    let index = start;
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current === '') {
        parts.push('');
        index += 1;
        continue;
      }
      if (!/^\s+/.test(current)) break;
      parts.push(current.trim());
      index += 1;
    }
    const text = mode === '|' ? parts.join('\n') : parts.filter((part) => part !== '').join(' ');
    return { value: text.trim(), next: index };
  }
  const items: Array<string | boolean> = [];
  let index = start;
  while (index < lines.length) {
    const current = lines[index] ?? '';
    if (!current.trim()) {
      index += 1;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(current);
    if (!item) break;
    items.push(parseScalar(item[1] ?? ''));
    index += 1;
  }
  return { value: items, next: index };
}

function parseScalar(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}
