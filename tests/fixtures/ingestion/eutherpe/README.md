# Fundación Eutherpe fixtures

Captured from the official Webflow site on 2026-09-04. Structural excerpts,
not invented production events. Scripts, CSS, images and unrelated layout
were removed; titles, dates, CMS calendar cells, directory cards and the
selectors used by the adapter remain.

There is no public JSON/JSON-LD/ICS feed. `/programacion` embeds the complete
CMS calendar (`bloque-meses` / `w-slide` months, no load-more). The upcoming
directory (`collection-item w-dyn-item`) can include a concert that the
calendar cell did not bind. `/programacion-shigeru-kawai-madrid` currently
republishes the same calendar collection.

- `listing.html`: https://www.fundacioneutherpe.com/programacion — September
  2026 complete (padding + days 1–30), four calendar bindings (two days of
  the JOL course, the 5 Sep closing concert, Luca Battipaglia on the 12th),
  Carmen Vilanova only in the directory, and a static leftover card with
  `href="#"` that must be ignored.
- `listing-madrid.html`: https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid
  — the same calendar with the Madrid heading and an empty upcoming
  collection.
- `detail-battipaglia.html`: https://www.fundacioneutherpe.com/conciertos/guitarra-clasica-luca-battipaglia-italia
- `detail-vilanova.html`: https://www.fundacioneutherpe.com/conciertos/piano-solo-carmen-vilanova-martinez-barcelona
- `detail-jol.html`: https://www.fundacioneutherpe.com/conciertos/i-concierto-de-clausura-xxii-curso-piano-y-direccion-con-la-jol-19-00-hs-auditorio-de-leon
- `detail-curso.html`: https://www.fundacioneutherpe.com/conciertos/xxii-curso-de-piano-y-direccion-con-la-jol-del-30-de-agosto-al-6-de-septiembre-2026
