# March fixtures

Reduced from the public pages observed on 2026-08-31:

- Listing: https://www.march.es/es/madrid/conciertos (all 11 cards, including the three initially hidden by “Mostrar más”). The archive link after the next heading is synthetic to test section isolation.
- https://www.march.es/es/madrid/concierto/andromeda-perseo
- https://www.march.es/es/madrid/concierto/ayres-extemporae
- https://www.march.es/es/madrid/concierto/memoriam-i-tombeaux-musicas-duelo
- https://www.march.es/es/madrid/concierto/beethoven-schubert-sombras-cruzadas-iii-formas-libertad

Navigation, SVG icons, unrelated JSON-LD and bios are omitted. Detail fixtures preserve canonical URLs, Event graphs, visible schedule labels and labelled programme HTML. Repeated descriptions/performers and unused image/offer/endDate fields are reduced; dates, venue, attendance mode and statuses are unchanged. The Wednesday JSON-LD time includes the interview before the concert; both original times are preserved to test that discrepancy. Captured through the browser during #40, when direct HTTP from the development environment did not reach March. Parser evidence remains valid. HTTP acquisition now depends on getText replaying the nginx Set-Cookie 307 and, in GitHub Actions, the fetch relay (`docs/ingestion.md`, `infra/fetch-relay`). Original evidence: `docs/archive/march-validation.md`.
