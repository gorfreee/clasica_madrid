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

## Production run 38532659060 regression — captured LIVE 2026-10-14

`main` at `3de663a3057eb7fa673c36805b1d20be43dfa414` was replayed with
these real responses and the requested 2026-10-14 → 2027-07-31 window.
It reproduced **exactly** `madrid-a-tempo: estructura inesperada`, after
16 `outside-window` discards, when reading page 2. The production artifact
records two HTTP 200s, no transport errors, no hydration, and those same
16 discards. The artifact does not contain response bodies, so the precise
production bytes cannot be asserted; the LIVE replay demonstrates the same
failure mechanism and diagnostic signature.

- `live-20261014-page2-empty-ssr.html`: first GET of
  https://www.madridatempo.com/proximos-conciertos/page/2 returned HTTP 200
  but **`<script id="wix-warmup-data">{}</script>`**, without title, Blog app
  or feed. This is an unrendered Wix SSR document, not an empty agenda.
  The old `asRecord(warmup.appsWarmupData)` throws the generic error.
- `live-20261014-page{1..5}.html`: subsequent official responses, retaining
  **all** 87 posts (20/20/20/20/7), their exact ids, titles, excerpts,
  slugs, URL objects and paging metadata. Removed unrelated chrome,
  user/profile/media fields and feed fields the parser does not consume.
  The Blog app ID, request-bearing feed key, string-encoded payload and
  `feedResponse.postFeedPage.posts.{posts,pagingMetaData}` nesting are kept.
  URLs are `/proximos-conciertos`, then `/proximos-conciertos/page/2` through
  `/proximos-conciertos/page/5` on `https://www.madridatempo.com`.

The same page-2 URL later returned the complete feed. An independent GET
of `/proximos-conciertos/page/2?cm_listing_retry=1` also returned the same
20 post identities and page=2/pageSize=20/offset=20/next cursor. This
query is used only for one bounded retry of the observed empty SSR shell;
all semantic validations still apply and published URLs never acquire it.
A fixed query avoids unbounded cache entries; it does not guarantee a fresh
origin response, which is why failed recovery remains incomplete.

**Comparison with September fixtures:** no demonstrated change to the warmup
schema, feed key, payload encoding, post shape or sequential page URLs.
The old healthy-page parser accepts the newly captured valid feeds. There
is no evidence for an alternate array feed or a new endpoint. The failure
is intermittently missing server-rendered content, not a supported alternate
representation. Feed request JSON is now parsed semantically rather than
regex/defaults; metadata count/offset/total/cursors and cross-page consistency
are checked. Wix uses `skipCount:true`, so `total:0` is not an empty-feed signal.

SHA-256 of full raw HTML before trimming (UTF-8; for capture provenance):

| Response | SHA-256 |
|---|---|
| Page 1 | `2f90771a0176b95ab84b3778efa76391f478100deb24b1bb449a6e03eb529f16` |
| Page 2, empty SSR | `76cf63b1076baefe6d40b75373b70ed27c7173ab41099eca3e0e26f7f7b29d80` |
| Page 2, later valid GET | `d7370aa64324b356d63af7ab232c359012a3964e670b07831e5af3a7afd6b14e` |
| Page 3 | `b6e3edc588619145688e6afc4c55bc7b0d772afd20e04e6a126c527fc6abdcc9` |
| Page 4 | `25266dca598aa921a35936328c13165dbe748aa5b6d1ae311348016595084933` |
| Page 5 | `663bc11135eb36c412dd9675a310d4f432b5e921b0894b5cec1f16d26cfbc9f9` |

### LIVE dry-run after the fix

Executed 2026-10-14 against the current published catalog, with no catalog
writes and no AI/classification changes:

```sh
node --import tsx src/cli/ingest.ts source madrid-a-tempo \
  --from 2026-10-14 --to 2027-07-31 --dry-run \
  --report /tmp/madrid-tempo-dry-run/report.json
```

This invokes the same entry point/arguments as `npm run ingest:source`;
`node --import tsx` avoids the local sandbox's restriction on tsx's IPC pipe.

- Pages processed: base URL and `/page/2`, `/page/3`, `/page/4`, `/page/5`.
- 87 feed posts: 51 `outside-window` adapter discards, one cycle index
  (not a concert), **35 extracted observations**.
- Hydration: **35 attempted / 35 succeeded / 0 failed**.
- All 35 observations end in `structural-skip: sin fecha`: their available
  concert schedule does not establish a publishable date with year. Existing
  schedule/hydration policy is preserved; no year is inferred from blog dates.
- **0 candidates**, 0 new/updated events, 0 possibly missing events.
- Source `status: ok`, **`health: clean`**, no suppressed coverage, no source
  failures. 40 HTTP 200 requests (5 listing + 35 detail), no retries/timeouts.
  This particular run did not need SSR recovery; the exact captured empty
  response and recovery path are exercised by regression tests.

A failed SSR recovery or later HTTP failure retains only observations from
previous validated pages through `IncompleteListingError`: the source remains
failed and the existing pipeline suppresses disappearances. Arbitrary malformed
feeds, contradictory identities, repeated cursors/pages and the page limit remain
visible structural failures, never successful empty agendas.
