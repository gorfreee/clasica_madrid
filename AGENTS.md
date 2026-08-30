# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 7** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). There is no backend, database, or auxiliary service — the Astro dev/preview server is the only service.

Canonical event data lives in `data/` and is validated at build/CI time. An empty catalog is valid.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the entire product. |

Scripts live in `package.json`. Use those names rather than duplicating flags here. The usual loop is `dev`, `validate`, `test`, `check` (Astro/TS diagnostics; there is no ESLint/Prettier), `build` (static output to `dist/`), and `preview`. Harvesting v3 (phases 1–2) is `ingest:sync` / `ingest:source`. `ingest:promote` remains as the legacy candidate-file path during the migration.

### Non-obvious notes

- Node 22 is required (`engines` in `package.json`). Installing may print a harmless `EBADENGINE` warning for `undici` wanting a newer Node 22 patch; it does not affect dev/build.
- Use `npm` (not pnpm/yarn). Keep `package-lock.json` committed so CI can `npm ci`.
- Windows `npm install` can drop optional WASM lockfile entries (`@emnapi/core`, `@emnapi/runtime`) that Linux `npm ci` (GitHub Actions and Cloudflare) requires. If install fails with those packages missing, restore the entries from git rather than re-running `npm install` on Windows.
- Do not invent production events. Fixtures belong in `tests/`.
- UI must consume `src/lib/presentation`, not raw JSON files.
- Pagefind is intentionally not installed yet; search is a query-param filter over the built agenda.
- For any ingestion-related work, `docs/ingestion-v3-plan.md` is the current target-architecture specification. `docs/ingestion.md` is the operational entry point (what is implemented today). Documents under `docs/archive/` are historical and must not be used as current requirements unless a task explicitly asks to research prior decisions.
- Ingestion v3 phase 1 lives in `src/ingestion/` (`ingest:sync`, `ingest:source`). Phase 2 is complete: 2.1 optional `hydrate` on adapters and detail parsers in `src/ingestion/detail/` (a detail-page failure is event-local); 2.2 deterministic classifier in `src/ingestion/classification/` plus composer knowledge in `src/ingestion/knowledge/`; 2.3 AI fallback (`classifyObserved` + `AiClassifier`) only when deterministic eligibility is `uncertain`, degrading to `uncertain` if the provider is missing or fails (tested with fakes — CI must never call a live LLM). Gemini/Gemma schedules the first available model from a preference-ordered pool (two Flash-Lite, then two Gemma defaults), with per-model RPM/TPM/RPD, a global 3-attempt event budget, at most 4 concurrent calls by default, and persistent cache/quota/pending state under `.local/ai/`. A local lock prevents overlapping runs sharing that directory. `GEMINI_MODEL` still pins a single model; `GEMINI_MODELS` wins. `--ai-model`, `--ai-no-cache`, and `--ai-max-requests` support bounded real checks; CI still never calls an LLM. See `docs/ingestion.md` for controls, migration and quota limitations. It does not rotate API keys; 2.4 publication gate in `runIngest` (only final `include` becomes a Candidate; `exclude`/`uncertain` are not published; Candidate uses classification `formats`/`eras`/`kind`/`access`; `provisionalKind` is gone). The CLI injects at most one `AiClassifier` per run via `createAiClassifierFromEnv()`. `--report <path>` writes a diagnostic JSON of per-event decisions; it does not change classification or publication. Candidate JSON + `ingest:promote` remains as a manual/legacy path. Working directories under `ingestion/inbox`, `work`, `rejected` and `reports` are gitignored. Batch writes use a short-lived `.ingest-tmp-*` directory inside the data tree (also gitignored). The ingest CLI rejects unknown flags and `--data-dir` / `--report` without a value. Do not remove that infrastructure unless a task says so. Do not implement later v3 phases (GitHub Actions, auto-merge, discovery agents, fuzzy reconciliation, disappearance policy) unless a task asks for that phase.
- Once an event or venue is published, its `slug` is permanent. Do not rename published slugs. Aliases and historical redirects are not implemented.
- Every published venue has a `/lugares/{slug}` page, including venues with no upcoming events. The venues index lists only venues with upcoming events.
- `loadPublishedCatalog()` memoizes the parsed catalog for the process lifetime. Tests that need another tree must call `loadCatalogFromDir`. Restart `astro dev` after editing `data/` if pages look stale.
- Direct pushes to `main` are allowed. Site CI must stay a single simple workflow: validate, test, typecheck, build. Do not add required pull requests or required status checks. A scheduled ingestion workflow and auto-merge of data PRs are part of the v3 *target*, not of the current implementation; do not add them unless a task explicitly implements that phase.
