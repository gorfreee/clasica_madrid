import { collapseWhitespace } from './html.ts';
import { normalizePersonList, type ObservedPerson } from './observed.ts';

const ROLE = 'piano|clarinete|viol[ií]n|viola|violonchelo|flauta|oboe|fagot|guitarra|arpa|[oó]rgano|clave|soprano|tenor|bar[ií]tono|director(?:a)?';
const NAME = String.raw`[\p{Lu}][\p{L}’'.-]+(?:\s+(?:de|del|la|las|los|y|[\p{Lu}][\p{L}’'.-]+)){1,9}`;

/** Current performance credits only; career lists and institutional staff are
 * deliberately not parsed as the cast of this event. */
export function extractExplicitPerformanceCredits(text: string): ObservedPerson[] {
  const people: ObservedPerson[] = [];
  for (const line of text.split(/[;\n]|\.\s+/u)) {
    const credit = new RegExp(`^\\s*(${NAME}),\\s*(${ROLE})[.]?\\s*$`, 'u').exec(line);
    if (credit) people.push({ name: credit[1]!, roleText: credit[2]! });
  }
  const performed = new RegExp(String.raw`\b[Ii]nterpretad[oa]\s+por\s+(?:la\s+|el\s+)?(${NAME})(?=\s+bajo\b|[,.;]|$)`, 'gu');
  for (const credit of text.matchAll(performed)) {
    people.push({ name: collapseWhitespace(credit[1]!) });
    const tail = text.slice((credit.index ?? 0) + credit[0].length);
    const conductor = new RegExp(String.raw`^\s+bajo\s+la\s+direcci[oó]n\s+de\s+(${NAME})(?=[,.;]|$)`, 'u').exec(tail);
    if (conductor) people.push({ name: conductor[1]!, roleText: 'director' });
  }
  return normalizePersonList(people);
}
