import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const filterForm = readFileSync('src/components/FilterForm.astro', 'utf8');
const toolbarCss = readFileSync('src/styles/agenda-toolbar.css', 'utf8');
const globalCss = readFileSync('src/styles/global.css', 'utf8');

describe('estructura de filtros avanzados', () => {
  it('mantiene el trigger en la toolbar y el panel como hermano posterior', () => {
    const toolbarStart = filterForm.indexOf('class="filters__toolbar"');
    const resultCount = filterForm.lastIndexOf('data-result-count');
    const toolbarClose = filterForm.indexOf('</div>', resultCount);
    expect(toolbarStart).toBeGreaterThan(-1);
    expect(toolbarClose).toBeGreaterThan(toolbarStart);

    const toolbar = filterForm.slice(toolbarStart, toolbarClose);
    const afterToolbar = filterForm.slice(toolbarClose);

    expect(toolbar).toContain('data-advanced-filters-toggle');
    expect(toolbar).toContain('aria-expanded="false"');
    expect(toolbar).toContain('aria-controls="agenda-advanced-filters"');
    expect(toolbar).not.toContain('data-advanced-filters-panel');
    expect(toolbar).not.toMatch(/<details[\s>]/);

    expect(afterToolbar).toContain('data-advanced-filters-panel');
    expect(afterToolbar).toContain('id="agenda-advanced-filters"');
    expect(afterToolbar).toContain('hidden');
    expect(filterForm).not.toMatch(/<details[\s>]/);
    expect(filterForm).not.toMatch(/<summary[\s>]/);
  });

  it('usa un chevron de expansión y no un símbolo de cierre', () => {
    expect(filterForm).toContain('filters__toggle-mark');
    expect(filterForm).toContain('viewBox="0 0 10 6"');
    expect(filterForm).not.toMatch(/filters__summary-mark/);
    expect(filterForm).not.toMatch(/aria-hidden="true">[+\u00d7×]/);
  });

  it('no recoloca el trigger ni el panel con order o flex al abrirse', () => {
    for (const css of [toolbarCss, globalCss]) {
      expect(css).not.toMatch(/filters__advanced/);
      expect(css).not.toMatch(/\[open\]/);
      expect(css).not.toMatch(/aria-expanded[^\{]{0,80}\{[^}]*\border\s*:/);
      expect(css).not.toMatch(/filters__toggle[^{]*\{[^}]*flex:\s*0\s+0\s+100%/);
      expect(css).not.toMatch(/filters__panel[^{]*\{[^}]*\border\s*:/);
    }
  });
});
