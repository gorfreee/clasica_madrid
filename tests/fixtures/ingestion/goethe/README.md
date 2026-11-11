# Fundación Goethe fixtures

Captured from the official site on 2026-09-04. Structural excerpts, not
invented production events. Scripts, CSS, images and unrelated layout were
removed; headings, labelled sidebar fields, dates, venues and the selectors
used by the adapter remain.

There is no public JSON/ICS/WordPress REST calendar. `/es/eventos/` is a
static Eleventy listing: an upcoming `<ul class="divide-y">` plus an archive
accordion. Event JSON-LD on fichas stores `Date.toString()` in GMT+0000 and
is not used for the schedule.

- `listing.html`: https://www.fundaciongoethe.org/es/eventos/ — three
  upcoming cards (Madrid, Barcelona, El Escorial) and a truncated 2026
  archive so tests can prove past events are not harvested.
- `detail-cantus.html`: https://www.fundaciongoethe.org/es/eventos/concierto-cantus-juvenum-madrid-2026/
- `detail-candel.html`: https://www.fundaciongoethe.org/es/eventos/concierto-piano-jose-antonio-candel-barcelona-2026/
- `detail-schulz.html`: https://www.fundaciongoethe.org/es/eventos/concierto-organo-robert-schulz-el-escorial-2026/
- `detail-el-pardo.html`: https://www.fundaciongoethe.org/es/eventos/das-gibts-nur-einmal-el-pardo-2026/
  (past concert: labelled date and artists, no start time)

Captured from the same listing on 2026-11-11. The upcoming cards now mark the
venue with `text-xs hidden xl:block text-gray-600` (token order is not part
of the contract). Event URLs on that capture are still `/es/eventos/{slug}/`.
Tests also rewrite those hrefs to `/es/eventos/{year}/{yy-mm-dd-slug}/`; that
route shape is accepted, but those rewritten URLs were not fetched as live
pages.

- `listing-current.html`: https://www.fundaciongoethe.org/es/eventos/ — six
  upcoming cards (Madrid visit at Herrenknecht; Adviento in Sevilla,
  Barcelona, Alicante, Madrid and Málaga) and one real archive link so past
  events, including a Madrid one, stay out of the harvest.
- `detail-herrenknecht.html`: https://www.fundaciongoethe.org/es/eventos/ampliacion-linea-11-metro-madrid-herrenknecht-2026/
- `detail-adviento-madrid.html`: https://www.fundaciongoethe.org/es/eventos/concierto-adviento-madrid-2026/
  (the roster is labelled `Aristas` on the ficha)
