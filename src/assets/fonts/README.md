# Archivo webfont

`archivo-latin-ext-wght.woff2` is a self-hosted subset of Archivo from
https://github.com/Omnibus-Type/Archivo at commit
`211127690e8ff106c36c935f7e5e697114cff103`.

It is derived from `fonts/variable/Archivo[wdth,wght].ttf` with:

- the width axis fixed at the normal width (`wdth=100`);
- the weight axis restricted to the range used by the site (`wght=400:800`);
- WOFF2 output;
- Basic Latin, Latin-1, Latin Extended A/B and Additional, combining marks,
  general punctuation, currency symbols, letterlike symbols and arrows.

This keeps the site to one same-origin font request while retaining the
European names used by the catalogue. Interface icons remain CSS/SVG shapes so
their appearance does not depend on font glyph coverage. The font remains
licensed under the SIL Open Font License 1.1; see `OFL.txt`.
