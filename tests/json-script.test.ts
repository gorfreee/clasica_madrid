import { describe, expect, it } from 'vitest';
import { serializeJsonForScript } from '../src/lib/util/json-script.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { makeCatalog, makeEvent, testClock } from './helpers.ts';

describe('serializeJsonForScript', () => {
  it('impide que </script> cierre el elemento HTML', () => {
    const payload = { name: '</script><script>alert(1)</script>' };
    const embedded = serializeJsonForScript(payload);
    expect(embedded).not.toContain('<');
    expect(embedded).not.toContain('>');
    expect(embedded).not.toMatch(/<\/script>/i);
    expect(JSON.parse(embedded)).toEqual(payload);
  });

  it('escapa <, > y & sin romper el JSON', () => {
    const payload = { html: '<b>a & b</b>' };
    const embedded = serializeJsonForScript(payload);
    expect(embedded).toContain('\\u003c');
    expect(embedded).toContain('\\u003e');
    expect(embedded).toContain('\\u0026');
    expect(JSON.parse(embedded)).toEqual(payload);
  });

  it('sigue produciendo JSON-LD parseable para Schema.org', () => {
    const catalog = makeCatalog({
      events: [
        makeEvent({
          title: 'Concierto </script><script>alert("xss")</script>',
        }),
      ],
    });
    const page = buildEventPageModel(catalog, 'matinees-de-otono', testClock);
    expect(page).not.toBeNull();
    const embedded = serializeJsonForScript(page?.jsonLd);
    const parsed = JSON.parse(embedded) as Record<string, unknown>[];
    expect(parsed[0]?.['@context']).toBe('https://schema.org');
    expect(parsed[0]?.['@type']).toBe('MusicEvent');
    expect(parsed[0]?.name).toBe('Concierto </script><script>alert("xss")</script>');
    expect(embedded).not.toMatch(/<\/script>/i);
  });
});
