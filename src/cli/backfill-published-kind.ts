#!/usr/bin/env npx tsx
/**
 * One-off backfill: rewrite published event `kind` from the canonical venue
 * via `resolveKind`. Default is dry-run. Pass `--apply` to write.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  planPublishedKindBackfill,
  replacePublishedKind,
  type PublishedKindChange,
  type PublishedKindPlan,
} from '../ingestion/classification/published-kind.ts';
import { defaultDataDir } from '../lib/repository/fs.ts';
import { loadCatalogFromDir } from '../lib/repository/load.ts';

const apply = process.argv.includes('--apply');
const dataDir = defaultDataDir();
const catalog = await loadCatalogFromDir(dataDir);
const plan = planPublishedKindBackfill(catalog);

printPlan(plan);

if (plan.issues.length > 0) {
  console.error(`\n${plan.issues.length} evento(s) no se pueden reclasificar:`);
  for (const issue of plan.issues) {
    console.error(`- ${issue.path}: ${issue.reason}`);
  }
  process.exit(1);
}

if (!apply) {
  console.log('\nDry-run. Pasa --apply para escribir los kind distintos.');
  process.exit(0);
}

for (const change of plan.changes) {
  const filePath = path.join(dataDir, 'events', `${change.eventId}.json`);
  const raw = await readFile(filePath, 'utf8');
  const next = replacePublishedKind(raw, change.to);
  if (next === raw) {
    throw new Error(`no se pudo sustituir kind en ${change.eventId}`);
  }
  await writeFile(filePath, next, 'utf8');
}

console.log(`\nEscritos ${plan.changes.length} evento(s) en ${dataDir}.`);

function printPlan(plan: PublishedKindPlan): void {
  const toEstablished = plan.changes.filter((change) => change.from === 'alternative' && change.to === 'established');
  const toAlternative = plan.changes.filter((change) => change.from === 'established' && change.to === 'alternative');

  console.log(`Eventos analizados: ${plan.analyzed}`);
  console.log(
    `Antes: established=${plan.before.established} alternative=${plan.before.alternative}`,
  );
  console.log(`Después: established=${plan.after.established} alternative=${plan.after.alternative}`);
  console.log(`Cambios: ${plan.changes.length}`);
  console.log(`  alternative → established: ${toEstablished.length}`);
  console.log(`  established → alternative: ${toAlternative.length}`);

  console.log('\nPor venue:');
  for (const row of summarizeByVenue(plan.changes)) {
    console.log(`- ${row.venueName} (${row.venueId}): ${row.count} [${row.directions}]`);
  }
}

function summarizeByVenue(changes: PublishedKindChange[]): Array<{
  venueId: string;
  venueName: string;
  count: number;
  directions: string;
}> {
  const grouped = new Map<
    string,
    { venueName: string; count: number; fromTo: Map<string, number> }
  >();
  for (const change of changes) {
    const row = grouped.get(change.venueId) ?? {
      venueName: change.venueName,
      count: 0,
      fromTo: new Map<string, number>(),
    };
    row.count += 1;
    const key = `${change.from} → ${change.to}`;
    row.fromTo.set(key, (row.fromTo.get(key) ?? 0) + 1);
    grouped.set(change.venueId, row);
  }
  return [...grouped.entries()]
    .map(([venueId, row]) => ({
      venueId,
      venueName: row.venueName,
      count: row.count,
      directions: [...row.fromTo.entries()]
        .map(([direction, count]) => `${direction} ×${count}`)
        .join(', '),
    }))
    .sort((a, b) => b.count - a.count || a.venueName.localeCompare(b.venueName, 'es'));
}
