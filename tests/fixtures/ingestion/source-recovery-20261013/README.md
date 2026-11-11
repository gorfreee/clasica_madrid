# Official response snapshots — 2026-10-13

Regression evidence for ingestion run 38145788312; captured by direct HTTP GET.

- `cndm.html`: https://cndm.inaem.gob.es/eventos/202707 — HTTP 200, 31 calendar days, one concert in Salamanca. This disproves a persistent template failure, not the historical 503.
- `refugio.html`: https://realhermandaddelrefugio.org/categoria-eventos/conciertos/ — HTTP 200, rendered JetEngine empty state without `data-pages`. An empty archive alone cannot establish coverage.
- `refugio-rest.json`: official `/wp-json/wp/v2/calendario-eventos`, category 47, `status=publish`, 50 rows/page, `_envelope=1`, order by ID ascending, `_fields=id,slug,link,title,status,categoria-eventos,class_list,content`. JSON-only Accept. HTTP 200 envelope, total 33, one page. These identities still require detail calendar hydration.

Fixtures are exact response bodies. Historical 503/202 and browser timeout are recorded in the original artifact; transport regressions inject those statuses, rather than inventing server HTML.

`cndm-oct.html`: https://cndm.inaem.gob.es/eventos/202610, captured the same day over direct HTTP (200). Full 31-day calendar, 21 cards including Madrid and other cities. Validates recovery when the relay is unavailable. The original run manifest shows all ten monthly relay requests failed (500×2, 503×4, timeout×4), not just July; the report only surfaced the last failure.
