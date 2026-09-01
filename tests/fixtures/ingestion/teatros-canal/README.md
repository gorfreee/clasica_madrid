# Teatros del Canal fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. Images, scripts, cookie UI and the long
season-subscription legal dump were removed; selectors used by the adapter
are retained.

The HTML listing at https://cdn.teatroscanal.com/entradas/musica/ (and the
www canonical of the same page) is a truncated “en cartel” view. Harvesting
uses The Events Calendar REST API that backs that page:

`https://www.teatroscanal.com/wp-json/tribe/events/v1/events?categories=musica`

- `listing.json`: slim TEC JSON for that `musica` window (no images).
- `listing-sample.json`: five representative events (festival range, same-day
  paid, same-day without time).
- `detail-*.html`: canonical URL + `.single-event` ficha from
  `https://www.teatroscanal.com/espectaculo/<slug>/`.
