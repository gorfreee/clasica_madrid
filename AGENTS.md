# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 7** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). There is no backend, database, or auxiliary service — the Astro dev/preview server is the only service.

Canonical event data lives in `data/` and is validated at build/CI time. An empty catalog is valid.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the entire product. |

Scripts live in `package.json`. Use those names rather than duplicating flags here. The usual loop is `dev`, `validate`, `test`, `check` (Astro/TS diagnostics; there is no ESLint/Prettier), `build` (static output to `dist/`), and `preview`. Harvesting is `ingest:sync` / `ingest:source`. `ingest:promote` is the legacy candidate-file path.

### Documentation

| Need | Where |
|---|---|
| Product context | `PROJECT_CONTEXT.md` |
| Architecture principles | `ARCHITECTURE.md` |
| Data model | `docs/data-model.md` |
| Ingestion: what is implemented today | `docs/ingestion.md` |
| Ingestion: target architecture | `docs/ingestion-v3-plan.md` |
| Editorial classification policy | `docs/classification-policy.md` |
| Historical notes | `docs/archive/` |

`docs/archive/` is not current requirements unless a task asks to research prior decisions. Do not copy implementation details from the repo into these documents.

### Non-obvious notes

- Node 22 is required (`engines` in `package.json`). Installing may print a harmless `EBADENGINE` warning for `undici` wanting a newer Node 22 patch; it does not affect dev/build.
- Use `npm` (not pnpm/yarn). Keep `package-lock.json` committed so CI can `npm ci`.
- Windows `npm install` can drop optional WASM lockfile entries (`@emnapi/core`, `@emnapi/runtime`) that Linux `npm ci` (GitHub Actions and Cloudflare) requires. If install fails with those packages missing, restore the entries from git rather than re-running `npm install` on Windows.
- Do not invent production events. Fixtures belong in `tests/`.
- UI must consume `src/lib/presentation`, not raw JSON files.
- Pagefind is intentionally not installed yet; search is a query-param filter over the built agenda.
- For ingestion work, follow `docs/ingestion.md` (today) and `docs/ingestion-v3-plan.md` (target). Do not implement later v3 phases (GitHub Actions for ingest, auto-merge, discovery agents, fuzzy reconciliation) unless a task asks for that phase. `possiblyMissing` is diagnostic-only; do not delete or auto-cancel from a disappearance.
- Once an event or venue is published, its `slug` is permanent. Do not rename published slugs. Aliases and historical redirects are not implemented.
- Every published venue has a `/lugares/{slug}` page, including venues with no upcoming events. The venues index lists only venues with upcoming events.
- `loadPublishedCatalog()` memoizes the parsed catalog for the process lifetime. Tests that need another tree must call `loadCatalogFromDir`. Restart `astro dev` after editing `data/` if pages look stale.
- Direct pushes to `main` are allowed. Site CI must stay a single simple workflow: validate, test, typecheck, build. Do not add required pull requests or required status checks. A scheduled ingestion workflow and auto-merge of data PRs are part of the v3 *target*, not of the current implementation.
