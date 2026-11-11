import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_BLUE, SITE_BACKGROUND } from '../src/lib/presentation/constants.ts';

const root = path.join(import.meta.dirname, '..');

/** Hex, rgb() and hsl() literals. Numeric HTML entities (`&#8211;`) are not colors. */
const COLOR_LITERAL = /(?<!&)#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgb|hsl)a?\(/gi;
const RETIRED_BLUE = /#3346ff|rgba?\(\s*51\s*,\s*70\s*,\s*255/i;
const LEGACY_TOKEN = /(?<![\w-])--(?:paper-light|paper|ink|muted|line|blue|coral|free-mark|free|focus)\b/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function productionTextFiles(): string[] {
  return [...walk(path.join(root, 'src')), ...walk(path.join(root, 'public'))].filter((file) =>
    /\.(css|astro|ts|js|svg|json|webmanifest|html)$/.test(file),
  );
}

describe('sistema de color', () => {
  it('define el azul de marca en un único token CSS', () => {
    const css = readFileSync(path.join(root, 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/--color-brand:\s*#0055A0\s*;/);
    expect(css.match(/#0055A0/g)).toEqual(['#0055A0']);
    expect(css).toContain('color-mix(in srgb, var(--color-brand) 6%, transparent)');
    expect(css).toContain('color-mix(in srgb, var(--color-brand) 10%, transparent)');
    const styles = `${css}\n${readFileSync(path.join(root, 'src/styles/agenda-toolbar.css'), 'utf8')}`;
    expect(styles).toContain('var(--color-brand-wash)');
    expect(styles).toContain('var(--color-brand-tint)');
    expect(styles).not.toMatch(RETIRED_BLUE);
  });

  it('mantiene BRAND_BLUE, el manifest y los SVG alineados con el azul oficial', () => {
    expect(BRAND_BLUE).toBe('#0055A0');
    expect(SITE_BACKGROUND).toBe('#f1efe8');
    const manifest = JSON.parse(readFileSync(path.join(root, 'public/site.webmanifest'), 'utf8')) as {
      theme_color: string;
      background_color: string;
    };
    expect(manifest.theme_color).toBe(BRAND_BLUE);
    expect(manifest.background_color).toBe(SITE_BACKGROUND);
    for (const file of ['public/favicon.svg', 'public/brand/clasica-madrid-symbol.svg']) {
      const svg = readFileSync(path.join(root, file), 'utf8');
      expect(svg).toContain(`fill="${BRAND_BLUE}"`);
      expect(svg).not.toMatch(RETIRED_BLUE);
    }
  });

  it('no deja el azul de interfaz anterior en el código de producción', () => {
    const hits = productionTextFiles().filter((file) => RETIRED_BLUE.test(readFileSync(file, 'utf8')));
    expect(hits.map((file) => path.relative(root, file))).toEqual([]);
  });

  it('no hardcodea colores fuera de la definición central de tokens', () => {
    const uiDirs = ['src/components', 'src/pages', 'src/layouts', 'src/styles'];
    const offenders: string[] = [];
    for (const dir of uiDirs) {
      for (const file of walk(path.join(root, dir))) {
        if (!/\.(css|astro|ts)$/.test(file)) continue;
        let text = readFileSync(file, 'utf8');
        if (file.endsWith(`${path.sep}global.css`)) {
          text = text.replace(/:root\s*\{[\s\S]*?\n\}/, '');
        }
        const matches = text.match(COLOR_LITERAL);
        if (matches) offenders.push(`${path.relative(root, file)}: ${[...new Set(matches)].join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no reintroduce los nombres de token anteriores', () => {
    const hits = walk(path.join(root, 'src'))
      .filter((file) => /\.(css|astro|ts)$/.test(file))
      .filter((file) => LEGACY_TOKEN.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(hits).toEqual([]);
  });
});
