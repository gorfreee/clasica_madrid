# Madrid a Tempo fixtures

Captured from the official site on 2026-09-04. Structural excerpts, not
invented production events. Scripts, CSS, images and unrelated Wix chrome
were removed; titles, slugs, post ids, excerpts, JSON-LD and the warmup
blog feed used by the adapter remain.

There is no public Event JSON-LD, ICS or unauthenticated posts REST API.
The harvest surface is the Wix Blog `ALL_POSTS` feed embedded as
`wix-warmup-data` on `/proximos-conciertos`, with sequential
`/proximos-conciertos/page/{n}` pagination. Ficha facts live in
`BlogPosting` JSON-LD.

The festival landing `/programacion-2023` lists labelled days without an
explicit year, so it is not harvested.

- `listing.html`: https://www.madridatempo.com/proximos-conciertos
  — four posts from page 1 (inauguration, Ivo Lago, Maurizio Arroyo, cycle
  index) plus the real next-page cursor.
- `listing-sample.html`: the same four posts without pagination.
- `listing-page2.html`: https://www.madridatempo.com/proximos-conciertos/page/2
  — two historical posts and no next cursor.
- `listing-empty.html`: the same feed chrome with an empty `posts` array.
- `detail-inauguracion.html`
- `detail-ivo-lago.html`
- `detail-maurizio.html`
- `detail-ciclo.html`
- `detail-daniel.html`
- `detail-navidad-2024.html` — Wix JSON-LD `headline` truncated (~110 chars) with a literal `&amp;`
- `detail-sofia-sacco.html` — `&#010;` / wording drift (`7 de enero` vs `7 enero`) plus a truncated suffix
- `detail-silvia-escamilla.html` — extra inner whitespace and a truncated last word
