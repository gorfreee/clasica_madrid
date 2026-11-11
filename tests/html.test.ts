import { describe, expect, it } from 'vitest';
import { stripTags } from '../src/ingestion/html.ts';

describe('stripTags', () => {
  it('inserts whitespace when inline tags sit between words', () => {
    expect(stripTags('Nacionales</span>de España')).toBe('Nacionales de España');
    expect(stripTags('Nacionales<strong></strong>de España')).toBe('Nacionales de España');
    expect(stripTags('Orquesta y Coro Nacionales<span class="x"></span>de España')).toBe(
      'Orquesta y Coro Nacionales de España',
    );
  });
});
