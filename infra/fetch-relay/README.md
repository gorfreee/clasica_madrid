# Fetch relay (Cloudflare Worker)

GitHub-hosted runners receive HTTP 403 on `www.march.es`. This Worker is a
GET-only, authenticated fetch relay so ingestion can keep running in GitHub
Actions while adapters still see official March URLs.

It is not an open proxy.

## Behaviour

- accepts only `GET`
- requires `Authorization: Bearer <INGEST_FETCH_RELAY_TOKEN>`
- accepts only:
  - `https://www.march.es/es/madrid/conciertos`
  - `https://www.march.es/es/madrid/concierto/<slug>`
- follows a conservative number of **same-origin, still-allowlisted** redirects
- replays `Set-Cookie` from the nginx 307 challenge back to `www.march.es` only
- returns the final HTML
- never forwards cookies, `Set-Cookie`, or the Bearer token to the caller

The Node client (`getText` in `src/ingestion/http.ts`) sends the official
March URL as `?url=` and keeps that official URL as the logical address in
RawEvents, citations and reports.

## Deploy

From this directory, with Wrangler logged into the Cloudflare account that
already hosts Clásica Madrid (free Workers plan is enough):

```bash
npx wrangler secret put INGEST_FETCH_RELAY_TOKEN
npx wrangler deploy
```

Use a long random token; the same value goes into GitHub Actions.

## GitHub Actions secrets

| Secret | Value |
|---|---|
| `INGEST_FETCH_RELAY_URL` | Worker URL, e.g. `https://clasica-madrid-fetch-relay.<account>.workers.dev` |
| `INGEST_FETCH_RELAY_TOKEN` | Same token stored as a Wrangler secret |

Both must be set. An empty or half-configured relay fails March visibly and
does not change other sources. Local `ingest:source` without these variables
still uses direct fetch (which works on networks that receive the 307).

## Local ingest

Optional keys in `.local/ai.env` (gitignored):

```
INGEST_FETCH_RELAY_URL=https://clasica-madrid-fetch-relay.example.workers.dev
INGEST_FETCH_RELAY_TOKEN=…
```
