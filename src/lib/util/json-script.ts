/**
 * Serialize JSON so it is safe to embed inside a <script> element (JSON-LD or
 * application/json) via Astro `set:html`.
 *
 * JSON.stringify alone is not enough: a string value containing `</script>`
 * would close the HTML element and allow injection. Unicode-escaping `<`, `>`
 * and `&` keeps the payload valid JSON (and valid JSON-LD) while preventing
 * that breakout. U+2028 / U+2029 are escaped for older HTML consumers.
 */
export function serializeJsonForScript(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error('serializeJsonForScript: el valor no es serializable a JSON');
  }
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
