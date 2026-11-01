# Calendar update regressions (#396)

Captured 2026-11-01, no production ingestion rerun:

- `figaro.html`: reduced HTTP capture of https://www.teatroreal.es/es/espectaculo/bodas-figaro . Original hero, intro (including the whole advance notice) and complete `functions-show` section. Only whitespace-only Drupal gaps reduced; navigation/footer omitted. The table already has November 9 instead of 11. Tests add stale rows/listing dates as explicitly synthetic variants.
- `march.html`: reduced DOM capture in Chrome of https://www.march.es/es/madrid/concierto/diario-desaparecido-leos-janacek . Direct HTTP in this environment looped on 307; Chrome rendered the page. All four Event JSON-LD nodes and all four visible calendar labels are retained. Repeated unused description/performers/offers/endDate and navigation/calendar-provider controls are omitted. UTC startDate and local labels are unchanged. The structured calendar and JSON-LD both attest 18:30. The free-form artistic credits still mention noon on April 3/4; this fixture tests the existing parser's explicit CMS-calendar precedence, not a new prose date parser.
- `*-before.json`: verbatim published events from `ba1edd0cdc8a8eec8ab448a0ef1645a1d74fef98`, before #396, not the corrected main catalog.
- `observations.json`: verbatim observation records for the two URLs from run 41320194642, artifact `ingestion-run-41320194642-1` (artifact ID 13089357554), `events.jsonl`. Its `report.json` confirms the two occurrence diffs (old+new union). These are observed facts, not recreated LIVE HTML. Tests use the official HTML for parsing and replay the journal's listing facts for hydration.

Synthetic changes in tests are labelled in their test names. No production data is modified.
