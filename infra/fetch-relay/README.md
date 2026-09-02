# Fetch relay (Cloudflare Worker)

GitHub-hosted runners cannot reach some official sources reliably (today:
`www.march.es`, `teatrodelazarzuela.inaem.gob.es` and `auditorionacional.inaem.gob.es`
may return HTTP 403/503). This Worker is a GET-only,
authenticated fetch relay so ingestion can keep running in GitHub Actions
while adapters still see official URLs.

It is not an open proxy. It has **no source/host allowlist**: which hosts are
sent here is decided only by `useFetchRelay` on the source registry. Adding or
removing a relay source does not require changing this Worker, Cloudflare, or
GitHub Settings.

## Behaviour

- accepts only `GET`
- requires `Authorization: Bearer <INGEST_FETCH_RELAY_TOKEN>`
- accepts only public `https:` targets (no credentials, no non-default ports,
  no IP literals, no localhost / reserved names)
- follows a conservative number of **same-origin** redirects
- sends `Accept: application/json` only (no `text/html` / `*/*`) when the target path contains `/wp-json/` (SiteGround otherwise answers HTTP 202 HTML)
- replays `Set-Cookie` only back to the origin that set them, including
  across later requests in the same Worker isolate
- if the origin answers 403/503 (or similar) **and** sets a new cookie,
  retries that same URL once with the cookie (the March 307 challenge
  generalized to Imperva-style session cookies)
- returns the final HTML
- returns origin cookies to the **authenticated** caller only, via
  `x-relay-origin-cookie` (never as `Set-Cookie`, never in error bodies,
  never without a valid Bearer token)
- accepts the same header on the next request so GitHub Actions can keep
  the session even if the Worker isolate changes
- never forwards the caller's `Cookie` header, the Bearer token, or
  cookies to a different origin
- never puts the token in error bodies

The Node client (`getText` in `src/ingestion/http.ts`) sends the official
source URL as `?url=` and keeps that official URL as the logical address in
RawEvents, citations and reports.

## First deploy (Dashboard)

The Worker is a single file (`worker.js`) so the first test can be done from
the Cloudflare Dashboard before this workflow exists on `main`:

1. Workers & Pages → Create → skip the template / use the editor.
2. Name it `clasica-madrid-fetch-relay` (same as `wrangler.toml`) so a later
   GitHub deploy updates the same Worker.
3. Paste `worker.js`.
4. Settings → Variables and Secrets → add secret `INGEST_FETCH_RELAY_TOKEN`
   (never a plaintext variable).
5. Deploy. Copy the `*.workers.dev` URL into the GitHub repository variable
   `INGEST_FETCH_RELAY_URL`. The same token value goes into the GitHub secret
   `INGEST_FETCH_RELAY_TOKEN`.

## Deploy from GitHub

After merge, `.github/workflows/deploy-fetch-relay.yml` deploys this directory
on `workflow_dispatch` and on pushes to `main` that touch `infra/fetch-relay/`
(or the workflow itself). It uses `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `INGEST_FETCH_RELAY_TOKEN` as a Worker Secret.

## Local Wrangler (optional)

From this directory:

```bash
npx wrangler secret put INGEST_FETCH_RELAY_TOKEN
npx wrangler deploy
```

Not required for the first test or for later updates; Dashboard and the
GitHub workflow are enough.

## GitHub Actions

| Name | Kind | Value |
|---|---|---|
| `INGEST_FETCH_RELAY_URL` | repository variable | Worker URL, e.g. `https://clasica-madrid-fetch-relay.<account>.workers.dev` |
| `INGEST_FETCH_RELAY_TOKEN` | secret | Same token stored as a Wrangler/Dashboard secret |

The URL is not sensitive. An empty or half-configured relay fails sources
with `useFetchRelay` visibly and does not change other sources. Local
`ingest:source` without these variables still uses direct fetch (which works
on networks that receive the 307).

## Local ingest

Optional keys in `.local/ai.env` (gitignored):

```
INGEST_FETCH_RELAY_URL=https://clasica-madrid-fetch-relay.example.workers.dev
INGEST_FETCH_RELAY_TOKEN=…
```
