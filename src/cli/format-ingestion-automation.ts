#!/usr/bin/env npx tsx
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import {
  assertIngestReport,
  formatAutomationPrBody,
  formatAutomationSummary,
} from '../ingestion/automation.ts';

const options = parseOptions(process.argv.slice(2));
const raw = JSON.parse(await readFile(options.report, 'utf8')) as unknown;
assertIngestReport(raw);

await appendFile(options.summary, `${formatAutomationSummary(raw, options.runUrl)}\n`, 'utf8');
await writeFile(options.prBody, `${formatAutomationPrBody(raw, options.runUrl)}\n`, 'utf8');
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
  report: string;
  summary: string;
  prBody: string;
  runUrl: string;
  output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('Argumentos incompletos para format-ingestion-automation');
    values.set(name, value);
  }
  return {
    report: required(values, '--report'),
    summary: required(values, '--summary'),
    prBody: required(values, '--pr-body'),
    runUrl: required(values, '--run-url'),
    output: required(values, '--output'),
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} es obligatorio`);
  return value;
}
