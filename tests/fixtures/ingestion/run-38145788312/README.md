# Ingestion 38145788312: musical evidence and identity regressions

The production run is [38145788312](https://github.com/gorfreee/clasica_madrid/actions/runs/38145788312),
11 October 2026, on `main` `ff0eae8b134471dccf6b37478942b96c12bf0262`.
The artifact is `ingestion-run-38145788312-1` (ID `11705032038`).

- `observations.json`: selected **original** listing/observed facts copied from
  `report.json`; includes the errors being investigated, not corrected expected output.
- `published-before.json`: the four existing canonical records from that same
  `main`, before the data-only cleanup in #365. These expose the original matching
  problem instead of hiding it with added citations.
- HTML files: cropped **official live pages**, fetched 13 October 2026. Only the
  relevant H1, canonical/post ID, content widget and programme/credit blocks are
  retained. Navigation, related-event title widgets, styles and scripts are omitted.
  The fixture file stem matches `sourceId` and `externalId` in `observations.json`,
  where each original official URL is recorded.

The tests compare source parsing, normalization, enrichment, classification,
identity matching and reconciliation without network or real AI calls. They cover:

| Case | Structural regression |
| --- | --- |
| Las Rozas Hispanidad (9215) | Auditorium/school names cannot supply composer evidence; a mocked AI include cannot bypass that gate. |
| Concierto de Otoño (50427679) | A composer list ends before descriptions of works; «Montescos» cannot re-enter it or pass AI validation. |
| Reina Sofía recital (83109) | Explicit programme authors own their complete work titles; historical references and source material are not additional programmed authors. |
| Reina Sofía chamber programme (83078) | Current structured players supersede prose about institutional staff; inverted catalogue names normalize at ingestion. |
| Reina Sofía Maqam (85123) | The ensemble name excludes the poetic programme suffix. |
| Kebyart (64491) | Quoted cycle prefix and English `Quartet` identify the partner concert with the same schedule. |
| New Year (9196) | Explicit performing orchestra/conductor identify the same Filarmonía concert; seasonal titles are not works. |
| A&J (50265465) | Role-labelled list items supply the actual players; HTML entities are decoded at normalization. |
| Santa Cecilia (50427303) | Ordered composer headings and paragraphs supply the actual programme; biography, sub-concert headings and movements are kept out of works/cast. |

Negative tests protect against same-slot concerts with incompatible explicit casts,
shared opus numbers belonging to different composers, generic seasonal names,
and matching music with different venues, dates or times. Reconciliation tests
keep canonical IDs/slugs and richer existing facts, retain citations and verify
idempotency. A distinct URL from the same source also remains a citation.
