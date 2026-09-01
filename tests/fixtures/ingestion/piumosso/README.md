# Fundación Più Mosso fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. Scripts, CSS, images and unrelated layout were
removed; JSON-LD Event graphs, CMS ids, dates, venues and the selectors used
by the adapter remain.

The Events Calendar REST API (`/wp-json/tribe/events/v1/`) answers 401.
`/programacion/` embeds the complete Event JSON-LD (upcoming + archive) and
the same 72 cards (`id="event-{postId}"`) without load-more. The ICS at
`/programacion/?ical=1` matches the 11 upcoming events and was used only as
coverage cross-check.

- `listing.html`: https://www.fundacionpiumosso.com/programacion/ — two
  JSON-LD Event arrays, two `id="ect-grid-wrapper"` grids (próximos +
  celebrados) and four `ect-grid-event` cards (Tretyakov, Prisuelos,
  a date-only festival slot, Getafe). The live page also publishes the
  archive in the second grid; this excerpt keeps that second wrapper empty.
- `detail-tretyakov.html`: https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano/
- `detail-prisuelos.html`: https://www.fundacionpiumosso.com/evento/mario-prisuelos-musica-callada-de-frederic-mompou/
- `detail-festival.html`: https://www.fundacionpiumosso.com/evento/festival-alicia-de-larrocha-casa-de-vacas-del-retiro/
- `detail-getafe.html`: https://www.fundacionpiumosso.com/evento/orquesta-sinfonica-de-getafe-concierto-numero-2-de-s-rachmaninov/
