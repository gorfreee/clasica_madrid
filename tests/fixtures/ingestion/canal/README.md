# Fundación Canal fixtures

Captured from the official site on 2026-09-01. Structural excerpts, not
invented production events. Scripts, CSS, SVGs and unrelated chrome were
removed; JSON-LD, accordion/cards and the selectors used by the adapter
are retained.

- `camara-listing.html`: https://www.fundacioncanal.com/ciclo-musica-camara/
  — CollectionPage JSON-LD ItemList, accordion of the next concert plus
  recent past concerts, and the cycle sidebar (venue / donation).
- `camara-empty.html`: the same cámara template with an empty ItemList and
  no accordion cards.
- `familia-proximas.html`: archive card markup as served for Música en
  Familia, with one concert (copied from the live archive card).
- `familia-proximas-empty.html`: https://www.fundacioncanal.com/ciclo-musica-en-familia/proximas/
  — upcoming filter with the explicit empty notice. JSON-LD still lists
  past concerts; the adapter must ignore it.
- `otros-proximas.html`: archive card markup for Otros conciertos.
- `otros-proximas-empty.html`: https://www.fundacioncanal.com/otros-conciertos/proximas/
  — upcoming filter with «No hay eventos».

The WordPress CPT REST routes are not public. Concert fichas of the chamber
cycle render an empty `<main>`. Tests mutate these excerpts for missing
structure, URL/JSON-LD coverage mismatches, unparseable dates, pagination
and empty calendars.
