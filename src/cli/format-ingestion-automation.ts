import { appendFile, readFile, writeFile } from 'node:fs/promises';
import {
  assertIngestReport,
  formatAutomationPrBody,
  formatAutomationSummary,
  formatMissingReportSummary,
} from '../ingestion/automation.ts';
import type { IngestRunManifest } from '../ingestion/observability.ts';

const options = parseOptions(process.argv.slice(2));
const manifest = options.runManifest
  ? ((JSON.parse(await readFile(options.runManifest, 'utf8')) as IngestRunManifest))
  : undefined;
const extras = {
  ...(manifest ? { manifest } : {}),
  ...(options.artifactName ? { artifactName: options.artifactName } : {}),
};

if (!options.report) {
  await appendFile(options.summary, `${formatMissingReportSummary(options.runUrl, extras)}\n`, 'utf8');
  await appendFile(options.output, 'report_available=false\n', 'utf8');
  process.exit(0);
}

const raw = JSON.parse(await readFile(options.report, 'utf8')) as unknown;
assertIngestReport(raw);

await appendFile(options.summary, `${formatAutomationSummary(raw, options.runUrl, extras)}\n`, 'utf8');
if (options.prBody) {
  await writeFile(options.prBody, `${formatAutomationPrBody(raw, options.runUrl)}\n`, 'utf8');
}
await appendFile(
  options.output,
  [
    `health=${raw.health}`,
    `auto_merge_eligible=${String(raw.autoMergeEligible)}`,
    `report_available=true`,
  ].join('\n') + '\n',
  'utf8',
);

function parseOptions(argv: string[]): {
  report?: string;
  summary: string;
  prBody?: string;
  runUrl: string;
  output: string;
  runManifest?: string;
  artifactName?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('Argumentos incompletos para format-ingestion-automation');
    values.set(name, value);
  }
  return {
    report: values.get('--report'),
    summary: required(values, '--summary'),
    prBody: values.get('--pr-body'),
    runUrl: required(values, '--run-url'),
    output: required(values, '--output'),
    runManifest: values.get('--run-manifest'),
    artifactName: values.get('--artifact-name'),
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} es obligatorio`);
  return value;
}
