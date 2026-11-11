# Fundación ORCAM fixtures

Structural excerpts, not invented production events. Scripts, CSS,
images/SVGs and unrelated layout were removed; programme/credit text and
the selectors used by the adapter are retained.

Captured on 2026-08-31:

- `listing.html`: https://fundacionorcam.org/programacion/ — the entire main
  calendar, all 18 concert cards and the original Search & Filter month
  counts. No season/category hardcoding in the parser.
- `detail-symphonic.html`: https://fundacionorcam.org/conciertos/2026-27/la-creacion-de-un-todo/
- `detail-chamber.html`: https://fundacionorcam.org/conciertos/2026-27/volver-a-creer/
- `detail-christmas.html`: https://fundacionorcam.org/conciertos/2026-27/resonancias-de-navidad/

Revalidated on 2026-11-11, the same day as ingestion run 43056214891
(`b05b75a`). The listing card 4960 prints `5 y 6 de diciembre de 2026` and
no time. December's month count is 4 concerts, so that card is one concert,
not two sessions. The detail
https://fundacionorcam.org/conciertos/2026-27/concierto-de-navidad-un-dia-de-canciones/
uses the other template: no fixed date, time or room widgets. It states
sábado 5 de diciembre de 2026 a las 17:00 and domingo 6 de diciembre de 2026
a las 12:00, and the venue widget is only `Real Teatro de Retiro`. The
address line is a separate widget and is not a room. A classic ficha checked
the same day (`esencias-de-villancicos`) still has the date, time and room
widgets.

- `listing-20261111.html`: the whole `<main>` calendar that day, including
  the 17 cards, the month counts and the Elementor load-more spinner. The
  spinner is not a next page.
- `detail-navidad-retiro.html`: the widgets of that ficha used by the parser.

Detail excerpts retain the canonical URL, WordPress `postid`, single-post
wrapper and relevant Elementor widgets. Tests additionally mutate these
excerpts for malformed dates, unknown structures, off-site links, missing
coverage, failed hydration and cross-source identity. The small Auditorio
article in the cross-source test is a synthetic structural equivalent of
the same programme.
