# Real Academia de Bellas Artes de San Fernando fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. Scripts, CSS, images and unrelated layout were
removed; titles, dates, CMS ids and the selectors used by the adapter remain.

The public WordPress REST API is authenticated-only. There is no ICS/JSON-LD
Event feed. The harvest surface is the `actividad_type=conciertos` archive.

- `listing.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/
  — the custom `rc-actividades-block__list` of 12 cards (newest first) plus
  sequential pagination (`rel=next` / `page/2/`). Dates are Spanish phrases
  as served, including the two-day guitar festival.
- `listing-page2.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/page/2/
  — three historical cards used to prove pagination follow-and-stop.
- `detail-paraisos.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/paraisos-nocturnos/
- `detail-guitar.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/festival-internacional-de-guitarra-de-madrid-1-2/
- `detail-piano.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/concierto-ii-del-festival-caprichos-del-romanticismo/
- `detail-seikilos.html`: https://www.realacademiabellasartessanfernando.com/actividades/conciertos/seikilos/
