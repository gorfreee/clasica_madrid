#!/usr/bin/env npx tsx
import { defaultDataDir } from '../lib/repository/fs.ts';
import { validateDataDir } from '../lib/validation/validate-dir.ts';

const root = process.argv[2] ?? defaultDataDir();
const report = await validateDataDir(root);

if (report.issues.length === 0) {
  console.log(`Catálogo válido: ${root}`);
  process.exit(0);
}

for (const issue of report.issues) {
  const where = issue.path ? `${issue.path}: ` : '';
  console.error(`[${issue.severity}] ${issue.code} ${where}${issue.message}`);
}

if (!report.ok) {
  process.exit(1);
}

console.log(`Catálogo válido con ${report.issues.length} aviso(s).`);
