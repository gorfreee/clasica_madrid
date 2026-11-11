# RTVE / Teatro Monumental fixtures

Captured from the official theatre website on 2026-08-31. RTVE links this site from its “Venta de entradas” navigation at https://www.rtve.es/orquesta-coro/programa-conciertos/.

- `listing.html`: the complete `filter-cards-container` region of https://www.teatromonumental.es/ (43 cards / 62 dated performances). Surrounding navigation, tracking scripts and cookie UI omitted. Indentation/trailing whitespace normalized in all HTML fixtures.
- `listing-single.html`: only the real A/1 card, for the common pipeline isolation tests.
- `detail-symphonic.html`: canonical link + event article from https://www.teatromonumental.es/eventos/concierto-sinfonico-a-1/; two performances.
- Other `detail-<slug>.html` files: canonical link + event article from `https://www.teatromonumental.es/eventos/<slug>/`. They cover a single symphonic date, young musicians, opera/zarzuela, a mixed programme, ABBA and a genuinely empty programme (Traffic Strings).
- `detail-i-camaraton-sinfonico-de-la-joav.html`, `detail-la-7-a-de-beethoven-necko-vidal.html` and `listing-joav-pack.html`: captured on 2026-11-11. Each ficha repeats 22.11.2026: one block has an explicit clock and a positive ticket id, and the next has an empty hour, a different price and `event=-9`. The listing labels that second control `COMPRAR PACK 2 EVENTOS JOAV`. These files are fixtures, not production events.

Fixture facts are not production events. Synthetic structural mutations and read-more wrappers live only in tests. Composer spellings/credits are kept exactly as published; the adapter does not correct or interpret them.
