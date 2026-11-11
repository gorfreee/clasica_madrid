# Great American Songbook / issue #376

`observations.json` preserves the two original `observed` objects verbatim
(including the empty performer/composer/work lists and the raw occurrence),
source URL and external ID from `events.jsonl`. It also keeps the original
classification and publication decisions. Run/artifact IDs, archive SHA-256 and
1-based JSONL line numbers are embedded beside each observation:

| Run | Artifact | Observation line | Decision line |
| --- | --- | --- | --- |
| 38543811672 | 11884231732 (`ingestion-run-38543811672-1`) | 1351 | 1590 |
| 39603845469 | 12348014102 (`ingestion-run-39603845469-1`) | 1296 | 1513 |

The two observed payloads are identical. Normalized copies and unrelated runtime
metadata are omitted; none of the musical facts or missing credits was repaired.

Before this fix, `main` at `6abffa3` (including #387 and #388) reproduces both
original decisions after `normalizeRawEvent` → `observedFactsFromNormalized`:
`include`, method `knowledge`, rule `known-classical-composer`, evidence
`George Gershwin`, `Kurt Weill`. Both original runs generated a publishable
Candidate; their `chamber` format came from `ai-formats`, not the deterministic
format resolver.

After the fix the same facts resolve to `exclude` / `popular-music-identity`.
The literal description clause declaring songs from the Great American Songbook
is evidence; no eligibility/taxonomy AI call or Candidate is generated.

Official source checked on 2026-10-23:
https://ateneodemadrid.com/evento/javier-botella-the-art-of-love/

The current page agrees with the captured description: an album presentation
of love songs from the Great American Songbook, attributed to Gershwin, Weill,
Van Heusen, Bloom and Legrand, at Cátedra Mayor on 2026-11-07 at 13:00. It lists
vocal/instrumental performers but no individually identified academic works.
There is no word “jazz” in the observed concert copy. Neighbouring-event links
and site navigation are not concert evidence.

The pipeline regression re-encodes the recorded description as escaped paragraph
HTML in a one-event The Events Calendar API envelope. This is a transport wrapper
for the real Ateneo adapter, not a claim to preserve the original HTTP response.
The test asserts that the extracted description equals the recorded description
and that the empty catalogue receives zero Candidates and zero new events.
