# Official listing structures — captured 2026-10-13

Structural excerpts of HTTP 200 responses from:

- `ayto.html`: https://www.aytosanlorenzo.es/eventos/ — the complete first MEC list, its own pagination configuration, and load-more marker. No card or date is removed. The `time=1792432800` and `time=1792605600` keys belong to the two dated cinema occurrences. The desktop list has no clock: those keys must not become inferred concert times.
- `alcala.html`: https://culturalcala.es/musica-y-danza/ — the first (music/dance) EventON calendar, all 20 card identities, original JSON-LD and prices, and original horizon configuration. Decorative markup and the unrelated second calendar are omitted. Three occurrences of event 56641 use the same ficha and validated `/var/ri-1.l-L1` and `/var/ri-2.l-L1` suffixes. These are observed structured dates, not proof that editorial prose or detail dates agree; discrepancy handling is a separate concern.

Tests retain complete card counts, repeated sessions, identity validation, horizon limits and deterministic extraction. Mutated fixtures are used only for negative tests.

The original `ayto.html` excerpt omitted the outer skin id. On 2026-11-01 that
wrapper (including its omitted closing div and internal load-more marker) was restored as `id="mec_skin_52683"` (the id already declared by the
retained `mecListView` config and verified in the new full-view capture). No
card, query, date or inner list markup changed. The new adapter deliberately
requires that boundary so unrelated MEC views cannot supply coverage signals.
