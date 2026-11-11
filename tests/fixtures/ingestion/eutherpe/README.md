# Fundación Eutherpe fixtures and validation

## Current surface — captured 2026-11-11

The adapter reads the official [Madrid cycle](https://www.fundacioneutherpe.com/programacion-shigeru-kawai-madrid).
It contains a full mixed-region calendar and a Madrid CMS directory. A page
heading or an artist's place of origin is **not** evidence of a Madrid venue.
Only the individual visible venue/cycle labels are used to select Madrid.

Webflow's `w-condition-invisible` matters: every Madrid directory card contains
an invisible fallback paragraph saying `Sala Eutherpe León (Alfonso V, Nº 10)`.
The visible label is `#ShigeruKawaiCenterMadrid`; the detail headers corroborate
it. These hidden paragraphs are not conflicting venue evidence. Hidden ticket
buttons also contain a self-link labelled `Comprar entradas`: they do not
establish paid access.

`live-2026-11-11/listing.html` retains the original heading, complete September
2026, January/April/May/June/September/October/November 2027 month blocks, and
all 14 Madrid directory cards. Other months, scripts, CSS, images and unrelated
layout were removed. Conditional classes, hrefs, titles, dates and programme
structure remain. The detail files are structural excerpts of the official
`https://www.fundacioneutherpe.com/conciertos/{filename without .html}` pages.
They include programme rows and biography material to test their separation.
Dates and clocks were checked against all 14 individual pages.

| Concert | Date | Time | Canonical detail slug |
|---|---|---|---|
| Emanuele Caporali | 2027-01-14 | 19:30 | `emanuele-caporali-piano-italia` |
| Ignacio Gómez-Pallete | 2027-02-04 | 19:00 | `ignacio-gomez-pallete-piano-madrid` |
| Antonio Ortiz duo | 2027-04-08 | 19:30 | `duo-antonio-ortiz-violin-y-antonio-ortiz-piano-espana` |
| Massimo Urbán | 2027-05-27 | 19:30 | `massimo-urban-piano-italia` |
| Carlota Galli | 2027-06-17 | 19:30 | `carlota-galli-italia` |
| Chanh–Florentini duo | 2027-09-23 | 19:30 | `duo-chanh--florentini-saxofon-y-piano-italia-y-china` |
| Carvajal–Oltra duo | 2027-10-21 | 19:30 | `el-duo-carvajal-oltra` |
| Alejandro Espina | 2027-11-11 | 19:30 | `alejandro-espina-piano-espana` |

The last six also have a second detail slug beginning `shigeru-kawai-center-madrid-`.
Both cards explicitly identify the same concert, day/month, clock and Madrid
cycle; the detail pages corroborate the year as 2027. Those six alternate pages
have empty programmes, while the canonical pages above contain the repertoire.
`DUPLICATE_SLUGS` records only these verified aliases. Coalescing requires both
directory cards, matching day/month/time and Madrid labels, plus compatible
calendar dates if supplied. No arbitrary same-date or same-instrument merging.
Unknown alternate URLs remain separate observations for the normal pipeline.

Directory cards lack a year: they must hydrate successfully, even when the
page heading includes a year. A different day/month, clock or visible venue
is a source conflict, never an instruction to publish stale listing facts.
Complete calendar months are validated before geographical filtering; an absent
or truncated directory or new pagination fails visibly. Required hydration
coverage uses the shared pipeline mechanism and suppresses disappearances
when those details fail. All facts remain observations; eligibility, formats,
eras and access belong to the shared classification pipeline.

Programme extraction reads every visible `programa-content` row, pairing its
`text-block-39` composer with its own work block. Bold paragraph headings and
dash-led works can be structured; movements and other text stay in the full
`programText`. A work never inherits an author from a previous row. No biography,
hidden blocks or generic cycle text is mined for repertoire. Artist/role
credits are read only from explicit soloist title syntax, not biographies.
Source spellings and even source typos (e.g. Ignacio's `op.25` for the published
Pastorale label) remain observations; the adapter does not silently rewrite
musical facts using outside knowledge.

### Dry-run

```bash
npm run ingest:source -- fundacion-eutherpe --dry-run --report /tmp/eutherpe-report.json
```

Validated on the actual site for the default 2026-11-11 → 2027-03-11 window:
8 Madrid observations, 8 successful detail hydrations, 2 candidates (Caporali
and Gómez-Pallete), 6 outside-window exclusions, zero León candidates, zero
batch duplicates and zero writes to `data/**`. The regression pipeline tests
also repeat the ingest against the resulting catalogue and check stable IDs,
no new events, no updates and no false disappearances. Access is unknown where
no visible price/free-entry evidence exists.

The venue's postal code is **28005**, corroborated by the venue operator's
[official concert announcement](https://www.polimusica.es/evento/concierto-piano-eutherpe-shigeru-kawai/).
The foundation's cycle heading incorrectly says 28003; it is not used to
infer or overwrite the address.

## Historical captures — 2026-09-04

Root-level HTML files retain the original fixtures: mixed-region listings,
Carmen Vilanova only in the directory, Luca Battipaglia, the JOL closing concert
and a multi-day JOL course with an inconsistent detail year. These fixtures
exercise calendar validation and multi-day preservation. They demonstrate why
the old zero-candidate dry-run did not validate Madrid publication. The old
Madrid page merely duplicated León's calendar and had an empty CMS directory.
