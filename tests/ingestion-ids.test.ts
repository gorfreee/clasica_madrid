import { describe, expect, it } from 'vitest';
import { uniqueId, uniqueSlug } from '../src/ingestion/ids.ts';

describe('uniqueId', () => {
  it('devuelve la base si está libre', () => {
    expect(uniqueId('evt_demo', new Set())).toBe('evt_demo');
  });

  it('añade sufijos deterministas ante colisiones consecutivas', () => {
    const used = new Set<string>(['evt_demo']);
    const first = uniqueId('evt_demo', used);
    expect(first).toBe('evt_demo_2');
    used.add(first);
    const second = uniqueId('evt_demo', used);
    expect(second).toBe('evt_demo_3');
    used.add(second);
    const third = uniqueId('evt_demo', used);
    expect(third).toBe('evt_demo_4');
  });

  it('en el límite de 120 caracteres el sufijo no recrea el valor ocupado', () => {
    const base = 'e'.repeat(120);
    const used = new Set<string>([base]);
    const first = uniqueId(base, used);
    expect(first).not.toBe(base);
    expect(first.length).toBe(120);
    expect(first.endsWith('_2')).toBe(true);
    used.add(first);
    const second = uniqueId(base, used);
    expect(second).not.toBe(base);
    expect(second).not.toBe(first);
    expect(second.length).toBe(120);
    expect(second.endsWith('_3')).toBe(true);
  });

  it('trunca una base extremadamente larga y sigue siendo única', () => {
    const used = new Set<string>();
    const first = uniqueId('x'.repeat(500), used);
    expect(first.length).toBeLessThanOrEqual(120);
    used.add(first);
    const second = uniqueId('x'.repeat(500), used);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(120);
  });
});

describe('uniqueSlug', () => {
  it('añade sufijos deterministas ante colisiones consecutivas', () => {
    const used = new Set<string>(['recital']);
    const first = uniqueSlug('Recital', used);
    expect(first).toBe('recital-2');
    used.add(first);
    expect(uniqueSlug('Recital', used)).toBe('recital-3');
  });

  it('en el límite de 120 caracteres el sufijo no recrea el slug ocupado', () => {
    const base = 'a'.repeat(120);
    const used = new Set<string>([base]);
    const first = uniqueSlug(base, used);
    expect(first).not.toBe(base);
    expect(first.length).toBe(120);
    expect(first.endsWith('-2')).toBe(true);
    used.add(first);
    const second = uniqueSlug(base, used);
    expect(second).not.toBe(base);
    expect(second).not.toBe(first);
    expect(second.length).toBe(120);
    expect(second.endsWith('-3')).toBe(true);
  });

  it('trunca un título extremadamente largo y resuelve varias colisiones', () => {
    const used = new Set<string>();
    const title = `Concierto ${'largo '.repeat(80)}`;
    const first = uniqueSlug(title, used);
    expect(first.length).toBeLessThanOrEqual(120);
    used.add(first);
    const second = uniqueSlug(title, used);
    const third = uniqueSlug(title, new Set([...used, second]));
    expect(new Set([first, second, third]).size).toBe(3);
    expect(second.length).toBeLessThanOrEqual(120);
    expect(third.length).toBeLessThanOrEqual(120);
  });
});
