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
