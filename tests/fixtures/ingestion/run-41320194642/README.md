# Programme attribution regressions from run 41320194642

`observations.json` copies the six **pre-cleanup** observation journal records
(`sourceId`, `sourceUrl`, `externalId`, `observed`, and `listing`) from artifact
`ingestion-run-41320194642-1`, artifact ID `13089357554`. It contains no sanitized
catalog events, classification results, provider responses or production secrets.

The HTML files are reduced **official page captures from 2026-11-02**, retaining
unaltered programme markup and the identity/schedule landmarks required by each
parser. The text and faulty parse results match the original observation journal.
They are not claimed to be archived HTML bytes from the November 1 run (the
artifact stores observations, not source HTML). In particular, CNDM's trailing
`de` after the Debussy work remains exactly as the page publishes it: this change
does not silently repair source copy.

Sources:

- CNDM: https://cndm.inaem.gob.es/node/23854
- RABASF: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/centro-cultural-coreano-3/
- Madrid: the three `sourceUrl` values in `observations.json`, IDs 50457938,
  50464545 and 50315446. Captures keep the `.tiny-text` editorial subtree.
- March: https://www.march.es/es/madrid/concierto/pop-folk-cuarteto-cuerda-ii
  (original structured facts and programme from the artifact, no HTML required
  because the first faulty boundary is deterministic enrichment).

On main `8656a39`, all six initial regression tests fail: CNDM has two rather
than four works and inherits Sotelo; RABASF has five works including the
traditional descriptor under Schoenberg; Madrid adds Guillermo Fernández Shaw;
enrichment adds Canción and McIntosh’s Lament; municipal metadata become works.

The test reparses HTML from the original listing where available. It then runs
normalization, deterministic enrichment, classification with fake AI, publication
and a second parse/reconciliation against **only the first test publication**.
No production catalog event is loaded. A synthetic venue isolates musical facts
from venue resolution. The additional markup variants are explicitly synthetic
mutations of these captures. Existing Auditorio #386 segmentation and merge tests
remain unchanged and run in the full suite.
