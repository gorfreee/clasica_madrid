import { promoteCandidateFile } from '../lib/validation/promote.ts';

const candidatePath = process.argv[2];
if (!candidatePath) {
  console.error('Uso: npm run ingest:promote -- <fichero-candidato.json>');
  process.exit(1);
}

const result = await promoteCandidateFile(candidatePath);
for (const issue of result.report.issues) {
  const where = issue.path ? `${issue.path}: ` : '';
  console.error(`[${issue.severity}] ${issue.code} ${where}${issue.message}`);
}

if (!result.report.ok) {
  process.exit(1);
}

if (result.written.length === 0) {
  console.log('Nada que escribir.');
  process.exit(0);
}

console.log('Escrito:');
for (const file of result.written) {
  console.log(`  ${file}`);
}
