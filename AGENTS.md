# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 5** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). There is no backend, database, or auxiliary service — the Astro dev/preview server is the only service.

Canonical event data lives in `data/` and is validated at build/CI time. An empty catalog is valid.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the entire product. |

Standard commands live in `package.json` scripts:

- `npm run dev` — dev server with HMR.
- `npm run validate` — deterministic validation of `data/`.
- `npm test` — Vitest (domain, schemas, filters).
- `npm run check` — `astro check` (type/diagnostics; there is no ESLint/Prettier).
- `npm run build` — `astro check` then `astro build`; static output goes to `dist/`.
- `npm run preview` — serves the built `dist/` output.
- `npm run ingest:promote` — promote a candidate JSON file into `data/` after validation.

### Non-obvious notes

- Node 22 is required (Astro 5). The environment ships Node 22, which is fine; installing prints a harmless `EBADENGINE` warning for `undici` wanting Node `>=22.19.0`, which does not affect dev/build.
- Use `npm` (not pnpm/yarn). Keep `package-lock.json` committed so CI can `npm ci`.
- Do not invent production events. Fixtures belong in `tests/`.
- UI must consume `src/lib/presentation`, not raw JSON files.
- Pagefind is intentionally not installed yet; search is a query-param filter over the built agenda.
- Ingestion working directories under `ingestion/inbox`, `work` and `rejected` are gitignored.
