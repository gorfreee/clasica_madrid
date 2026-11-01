# Ayuntamiento de San Lorenzo — regression #396

`listing-20261101.html` is a structural excerpt of the official GET
https://www.aytosanlorenzo.es/eventos/ captured on **2026-11-01**.
It retains the complete `mec_skin_52683` list, all 23 articles, its own
empty-state/load-more containers and the original `mecListView` configuration.
It also retains the unrelated `mec_skin_18558` monthly view, including its
“Sin eventos” articles. Other page sections/scripts/styles are omitted.

The selected list includes this exact link (also repeated in the detail button):

https://www.aytosanlorenzo.es/agenda-eventos/pleno-extraordinario-%f0%9f%93%a2/?occurrence=2026-11-03

Its card id is `75271`. The emoji has not been substituted or removed.
The 23 listing articles become 22 distinct occurrences after deduplication;
a repeated exposure of one occurrence is not a second performance. The
non-concert plenary observation is extracted, but generates no candidate.
The fixture test supplies an explicit synthetic terminal AJAX envelope;
it does not claim the first page is the whole calendar.

The original run 41320194642 artifact `ingestion-run-41320194642-1` confirms
zero observations and `tarjeta sin identidad, fecha o título` in `report.json`
and `events.jsonl`. Replacing just the emoji slug with ASCII reproduces the
causal distinction, but is not a production fix.

`listing.html`, `more.json`, and `detail.html` are earlier structural excerpts
from the same official listing, `mec_list_load_more` POST response and organ
concert detail (2026-09-26). Their event cards remain unchanged. New URL,
clock, pagination and malformed-card variants in tests are explicitly synthetic.

## Live dry-run evidence, 2026-11-01

On main's catalog at `9d20f9f`, without AI credentials and without writing
`data/**`, the corrected adapter extracted **26** distinct events across the
MEC pagination and hydrated **26/26** details. Health was `degraded` solely
for `unresolved-taxonomy`, with zero `possiblyMissing`. There was one new
candidate, “Presentación del disco: Vol. 12 Sinfonías de Gaetano Brunetti”.
The plenary card was retained as an observation and structurally skipped
(no recognized concert venue), not published.

Reina Sofía's corresponding dry-run extracted **6**, hydrated **6/6**, proposed
2 existing-event updates, kept 3 unchanged and left 1 ambiguous. No new event
or disappearance was proposed. Coverage remained technically incomplete,
with `source-failed:escuela-reina-sofia`; a one-source run is therefore `fatal`.

Commands (window matching the production run):

```sh
npm run ingest:source -- escuela-reina-sofia --dry-run --from 2026-11-01 --to 2027-07-31 --report ingestion/reports/recovery-reina/report.json
npm run ingest:source -- ayto-san-lorenzo --dry-run --from 2026-11-01 --to 2027-07-31 --report ingestion/reports/recovery-san/report.json
```

This environment denies the tsx CLI's Unix IPC socket (`listen EPERM`);
the same CLI entry point was run as `node --import tsx src/cli/ingest.ts source …`.
Reports/journals remain local and ignored by Git. No production workflow was run.

Capture normalization only: line endings, indentation and trailing whitespace.
