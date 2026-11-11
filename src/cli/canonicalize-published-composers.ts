import { defaultDataDir } from '../lib/repository/fs.ts';
import {
  applyPublishedComposerCanonicalization,
  auditAfterCanonicalization,
  formatComposerCatalogAudit,
  readPublishedEventFiles,
  auditPublishedComposers,
} from '../ingestion/published-composers.ts';

const apply = process.argv.includes('--apply');
const dataDirFlag = process.argv.find((arg) => arg.startsWith('--data-dir='));
const dataDir = dataDirFlag ? dataDirFlag.slice('--data-dir='.length) : defaultDataDir();

if (apply) {
  const result = await applyPublishedComposerCanonicalization(dataDir);
  console.log('## Antes');
  console.log(formatComposerCatalogAudit(result.before));
  console.log('');
  console.log(`Archivos escritos: ${result.filesWritten.length}`);
  console.log('');
  console.log('## Después');
  console.log(formatComposerCatalogAudit(result.after));
  process.exit(0);
}

const files = await readPublishedEventFiles(dataDir);
const events = files.map((file) => file.event);
const before = auditPublishedComposers(events);
const after = auditAfterCanonicalization(events);
console.log('## Antes');
console.log(formatComposerCatalogAudit(before));
console.log('');
console.log('## Después (en memoria, sin escribir)');
console.log(formatComposerCatalogAudit(after));
