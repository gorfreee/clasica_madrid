# AGENTS.md

## Cursor Cloud specific instructions

This repo is **Clásica Madrid**, a single-product static website built with **Astro 5** and **Tailwind CSS v4** (CSS-first, no `tailwind.config.*`). There is no backend, database, or auxiliary service — the Astro dev/preview server is the only service.

### Services

| Service | Dev command | Notes |
|---|---|---|
| Astro site | `npm run dev` | Serves on `http://localhost:4321`. This is the entire product. |

Standard commands live in `package.json` scripts:
- `npm run dev` — dev server with HMR.
- `npm run check` — `astro check` (type/diagnostics check; there is no ESLint/Prettier — this is the lint step).
- `npm run build` — runs `astro check` then `astro build`; static output goes to `dist/`.
- `npm run preview` — serves the built `dist/` output.

### Non-obvious notes

- Node 22 is required (Astro 5). The environment ships Node 22, which is fine; installing prints a harmless `EBADENGINE` warning for `undici` wanting Node `>=22.19.0`, which does not affect dev/build.
- There is **no lockfile** in the repo, so `npm install` resolves fresh each time. Use `npm` (not pnpm/yarn).
- No automated test runner is configured yet (Vitest/Playwright are only aspirational per `ARCHITECTURE.md`). "Testing" today means `npm run check` plus manually loading the page.
- The planned `data/` directory and `.github/` workflows referenced in `ARCHITECTURE.md`/`PROJECT_CONTEXT.md` do not exist yet.
