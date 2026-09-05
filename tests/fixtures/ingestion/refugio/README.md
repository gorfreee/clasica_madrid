# Real Hermandad del Refugio fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. Scripts, images and chrome were removed;
selectors used by the adapter are retained.

The public index https://realhermandaddelrefugio.org/conciertos/ is an
Elementor + JetEngine listing of the `calendario-eventos` CPT, with infinite
scroll (`posts_per_page: 4`) and a second grid of past events. Harvesting
prefers the WordPress REST collection:

`https://realhermandaddelrefugio.org/wp-json/wp/v2/calendario-eventos?categoria-eventos=47`

If REST stays unreachable (SiteGround HTTP 202), the adapter falls back to the
official taxonomy archive https://realhermandaddelrefugio.org/categoria-eventos/conciertos/
which lists future concerts with canonical ficha URLs, `data-post-id` and
`data-pages`. That archive is complete for upcoming concerts; `/conciertos/` is
not used.

- `listing.json`: five CPT rows (upcoming concerts, a past recital, and the
  2025 festival season landing).
- `listing-sample.json`: the two in-window concerts from that set.
- `listing-archive.html`: structural excerpt of the taxonomy archive (three
  future concerts). `listing-archive-noid.html` omits `data-post-id`.
  `listing-archive-page1.html` / `listing-archive-page2.html` cover pagination.
- `detail-*.html`: canonical URL + single-post template `5889` widgets
  (`Empieza` / `Termina` / `Hora` / `Lugar`). Related “Otros eventos” cards
  are present so the parser must ignore them. `detail-organo-2026.html` has
  no `Lugar` widget (empty ACF omits it). `detail-festival-landing.html` is
  a multi-day season page, not an individual concert.
