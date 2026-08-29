# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 7** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). There is no backend, database, or auxiliary service — the Astro dev/preview server is the only service.

Canonical event data lives in `data/` and is validated at build/CI time. An empty catalog is valid.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the entire product. |

Scripts live in `package.json`. Use those names rather than duplicating flags here. The usual loop is `dev`, `validate`, `test`, `check` (Astro/TS diagnostics; there is no ESLint/Prettier), `build` (static output to `dist/`), and `preview`. Promote a candidate with `ingest:promote`.

### Non-obvious notes

- Node 22 is required (`engines` in `package.json`). Installing may print a harmless `EBADENGINE` warning for `undici` wanting a newer Node 22 patch; it does not affect dev/build.
- Use `npm` (not pnpm/yarn). Keep `package-lock.json` committed so CI can `npm ci`.
- Windows `npm install` can drop optional WASM lockfile entries (`@emnapi/core`, `@emnapi/runtime`) that Linux `npm ci` (GitHub Actions and Cloudflare) requires. If install fails with those packages missing, restore the entries from git rather than re-running `npm install` on Windows.
- Do not invent production events. Fixtures belong in `tests/`.
- UI must consume `src/lib/presentation`, not raw JSON files.
- Pagefind is intentionally not installed yet; search is a query-param filter over the built agenda.
- Ingestion working directories under `ingestion/inbox`, `work` and `rejected` are gitignored.
- Once an event or venue is published, its `slug` is permanent. Do not rename published slugs. Aliases and historical redirects are not implemented.
- Every published venue has a `/lugares/{slug}` page, including venues with no upcoming events. The venues index lists only venues with upcoming events.
- `loadPublishedCatalog()` memoizes the parsed catalog for the process lifetime. Tests that need another tree must call `loadCatalogFromDir`. Restart `astro dev` after editing `data/` if pages look stale.
- Direct pushes to `main` are allowed. CI must stay a single simple workflow: validate, test, typecheck, build. Do not add required pull requests or required status checks.
