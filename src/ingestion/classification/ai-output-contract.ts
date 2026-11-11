/**
 * Compact output-contract for providers that cannot enforce JSON Schema
 * server-side. Derived from `AiRequest.schema` — never a second hand-written
 * schema. `json_schema` routes must not attach this: the API already receives
 * the schema in `response_format`.
 */

export const OUTPUT_CONTRACT_INSTRUCTION =
  'Devuelve únicamente JSON válido que cumpla exactamente este contrato:';

export function needsPromptOutputContract(responseFormat: string): boolean {
  return responseFormat === 'json-object' || responseFormat === 'none';
}

export function compactJsonSchemaContract(schema: unknown): string {
  return renderSchema(schema);
}

export function outputContractPrompt(schema: unknown): string {
  return `${OUTPUT_CONTRACT_INSTRUCTION}\n${compactJsonSchemaContract(schema)}`;
}

/** Append the compact contract to the system message when the route needs it. */
export function systemWithOutputContract(
  system: string,
  schema: unknown,
  responseFormat: string,
): string {
  if (!needsPromptOutputContract(responseFormat)) return system;
  return `${system}\n\n${outputContractPrompt(schema)}`;
}

function renderSchema(schema: unknown): string {
  if (!isRecord(schema)) return 'unknown';
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join('|');
  }
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'array') {
    const items = schema.items !== undefined ? renderSchema(schema.items) : 'unknown';
    const wrapped = needsParens(items) ? `(${items})` : items;
    const max = typeof schema.maxItems === 'number' ? `<=${schema.maxItems}` : '';
    return `${wrapped}[]${max}`;
  }
  if (type === 'object' || isRecord(schema.properties)) {
    if (!isRecord(schema.properties)) return 'object';
    const required = requiredKeys(schema.required);
    const fields = Object.entries(schema.properties).map(([key, value]) => {
      const optional = required && !required.has(key) ? '?' : '';
      return `${key}${optional}:${renderSchema(value)}`;
    });
    return `{${fields.join(',')}}`;
  }
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    return type;
  }
  return type ?? 'unknown';
}

function requiredKeys(required: unknown): Set<string> | undefined {
  if (!Array.isArray(required)) return undefined;
  return new Set(required.filter((key): key is string => typeof key === 'string'));
}

function needsParens(value: string): boolean {
  return /[|,]/.test(value) && !(value.startsWith('{') && value.endsWith('}'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
