# Ateneo de Madrid fixtures

Representative, reduced responses captured on 2026-09-14 from the official
The Events Calendar REST API:

`https://ateneodemadrid.com/wp-json/tribe/events/v1/events`

`listing.json` preserves the fields and HTML structures that determine
identity, pagination, schedules, venue evidence, access and musical context,
including official `Información y programa` PDF links on the Ateneo domain.
`regression.json` is a reduced capture of later listing items used as
classification/parser regressions (Café Central cycle; labeled `Concertista:`).
Large images and biographies were removed; no event facts used by the tests
were invented.

The adapter keeps those official programme URLs in `observed.description`. It
does not fetch or parse PDF bytes: the repo has no PDF text extractor, and a
naïve scan of current official programmes does not yield a usable text layer.

