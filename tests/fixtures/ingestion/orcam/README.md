# Fundación ORCAM fixtures

Captured from the official site on 2026-08-31. Structural excerpts, not
invented production events. Scripts, CSS, images/SVGs and unrelated layout
were removed; programme/credit text and the selectors used by the adapter
are retained.

- `listing.html`: https://fundacionorcam.org/programacion/ — the entire main
  calendar, all 18 concert cards and the original Search & Filter month
  counts. No season/category hardcoding in the parser.
- `detail-symphonic.html`: https://fundacionorcam.org/conciertos/2026-27/la-creacion-de-un-todo/
- `detail-chamber.html`: https://fundacionorcam.org/conciertos/2026-27/volver-a-creer/
- `detail-christmas.html`: https://fundacionorcam.org/conciertos/2026-27/resonancias-de-navidad/

Detail excerpts retain the canonical URL, WordPress `postid`, shared
single-post wrapper and relevant Elementor widgets, with their nested
containers. Tests additionally mutate these excerpts for malformed dates,
unknown structures, off-site links, missing coverage, failed hydration and
cross-source identity. The small Auditorio article in the cross-source
test is a synthetic structural equivalent of the same programme.
