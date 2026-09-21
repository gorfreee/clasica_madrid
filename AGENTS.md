# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 7** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). The public site has no database or application backend: Git + `data/**` are the source of truth, Cloudflare Pages serves the built HTML, and one isolated Pages Function handles `POST /api/contacto` without persistence.

Locally, the Astro dev/preview server is the only process you need. In production there is also deliberately small auxiliary infrastructure for catalog maintenance: GitHub Actions for site CI and automated ingestion, plus a Cloudflare fetch relay for sources that GitHub-hosted runners cannot reach. Those pieces are not a public API or a second product. Operational detail lives in `docs/ingestion.md` and `infra/fetch-relay/`.

Canonical event data lives in `data/` and is validated at build/CI time. An empty catalog is valid.

### Shape of the system

- Static public website (Astro build → Cloudflare Pages) plus the isolated contact Pages Function.
- Git + `data/**` as the published catalog.
- Site CI on pushes and pull requests (validate, test, typecheck, build, e2e smoke).
- Automated ingestion via GitHub Actions (scheduled and manual).
- Publication of catalog changes via `data/**` PRs, site CI, and conditional auto-merge when health and configuration allow.
- Minimal auxiliary infrastructure only when a concrete ingestion constraint requires it.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the public product. |

Scripts live in `package.json`. Use those names rather than duplicating flags here. The usual loop is `dev`, `validate`, `test`, `test:e2e` (Playwright smokes against `dist/`; needs a prior `build`), `check` (Astro/TS diagnostics; there is no ESLint/Prettier), `build` (static output to `dist/`), and `preview`. Harvesting is `ingest:sync` / `ingest:source`. Discovery context export is `ingest:discovery-context`; importing a batch locally is `ingest:discovery`. Production Discovery is the manual GitHub Action described in `docs/run-discovery-agent.md`. `ingest:promote` is the legacy candidate-file path. Live AI checks are `ai:smoke` (connectivity) and `ai:qualify` (quality benchmark); both are manual, never part of PR CI.

### Documentation

| Need | Where |
|---|---|
| Product context | `PROJECT_CONTEXT.md` |
| Architecture principles | `ARCHITECTURE.md` |
| Data model | `docs/data-model.md` |
| Ingestion: what is implemented today | `docs/ingestion.md` |
| Ingestion: remaining roadmap | `docs/ingestion-v3-plan.md` |
| Discovery: agent playbook | `docs/run-discovery-agent.md` |
| Discovery: search hints | `docs/discovery-search-hints.md` |
| Editorial classification policy | `docs/classification-policy.md` |
| Historical notes | `docs/archive/` |

`docs/archive/` is not current requirements unless a task asks to research prior decisions. See `docs/archive/README.md` for the authority hierarchy when a historical note contradicts current docs or code. Do not copy volatile implementation details from the repo into general documents; link to the executable source of truth instead.

### Non-obvious notes

- Node 22 is required (`engines` in `package.json`). Installing may print a harmless `EBADENGINE` warning for `undici` wanting a newer Node 22 patch; it does not affect dev/build.
- Use `npm` (not pnpm/yarn). Keep `package-lock.json` committed so CI can `npm ci`.
- Windows `npm install` can drop optional WASM lockfile entries (`@emnapi/core`, `@emnapi/runtime`) that Linux `npm ci` (GitHub Actions and Cloudflare) requires. If install fails with those packages missing, restore the entries from git rather than re-running `npm install` on Windows.
- Do not invent production events. Fixtures belong in `tests/`.
- UI must consume `src/lib/presentation`, not raw JSON files.
- Pagefind is intentionally not installed yet; search is a query-param filter over the built agenda.
- For ingestion work, follow `docs/ingestion.md` (current operation) and `docs/ingestion-v3-plan.md` (remaining roadmap). Scheduled ingestion, data PRs, conditional auto-merge, the fetch relay, Discovery v1 (structured context export / batch import), and the **manual** Discovery GitHub Action already exist. Do not reimplement them. Remaining v3 work — automatic web search inside the repo, discovery scheduling, automatic source learning/promotion, and fuzzy/IA residual reconciliation — is out of scope unless a task asks for that capability. `possiblyMissing` is diagnostic-only; do not delete or auto-cancel from a disappearance.
- Once an event or venue is published, its `slug` is permanent. Do not rename published slugs. A retired historical event slug may remain as an explicit `slugAliases` entry on the surviving canonical event so the old public URL still resolves; do not add a general redirect system.
- Every published venue has a `/lugares/{slug}` page, including venues with no upcoming events. The venues index lists every root venue in one list: venues with upcoming events first, followed by the rest.
- `loadPublishedCatalog()` memoizes the parsed catalog for the process lifetime. Tests that need another tree must call `loadCatalogFromDir`. Restart `astro dev` after editing `data/` if pages look stale.
- Direct pushes to `main` are allowed. Site CI must stay a single simple workflow: validate, test, typecheck, build, e2e smoke. Do not add required pull requests or required status checks. Do not fold ingestion orchestration into that site CI workflow.
- Agenda client filters depend on the `data-*` / `#agenda-filter-data` contract documented in `src/lib/presentation/agenda-client.ts`. Do not remove those attributes while that script exists; `e2e/` smokes guard the behaviour.
- When creating worker or custom subagents, never specify another model; always inherit the parent model.
- Do not use Browser / computer-use or screen-recording analysis unless it is the only practical way to verify the change. Default evidence is `test`, `test:e2e`, `check` and `build`. If computer use is needed, use the lightest method that works: a few screenshots over recordings, and recordings only when the task explicitly asks for video.
