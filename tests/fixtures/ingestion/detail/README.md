# Detail-page excerpts (parser samples)

These are **small structural samples** of official detail pages, not the golden evaluation set.

The golden set lives in `../golden/` as observed facts. Do not store dozens of full HTML dumps.

When Phase 2 implements detail hydration, add at most a few fixtures per source here and assert the parser against them.

| File | Source | Why it exists |
|---|---|---|
| `auditorio-ocne-sinfonico-01.excerpt.html` | Auditorio Nacional | Listing title is an internal code; program is in the detail page |
| `teatro-real-concierto-navidad.excerpt.html` | Teatro Real | Generic Christmas title; program on the ficha is popular, not classical |
