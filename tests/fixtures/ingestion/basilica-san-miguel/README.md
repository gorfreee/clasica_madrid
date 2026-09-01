# Basílica Pontificia de San Miguel fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. TEC images, Yoast blobs and unused venue
fields were removed; the fields used by the adapter are retained.

The HTML calendar at https://basilicadesanmiguel.org/calendario-actividades/
is a The Events Calendar list of the same upcoming posts. Harvesting uses
the official REST API that backs that page:

`https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events`

There is also an ICS export (`?ical=1`) with the same five upcoming
concerts and no extra programme. Fichas under `/actividad/{slug}/` repeat
title, datetime and venue; they do not add a parseable programme.

- `listing.json`: slim TEC JSON for the current upcoming window.
- `listing-sample.json`: four representative posts (same-day concert with
  venue and clock time, another concert, a liturgical activity without
  venue, a past concert whose `description` HTML names performers).
