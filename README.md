# Clásica Madrid

Agenda pública de conciertos y eventos de música clásica en Madrid y su entorno inmediato.

El producto y su alcance están en [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md). Las decisiones de arquitectura están en [`ARCHITECTURE.md`](ARCHITECTURE.md). Este README cubre cómo trabajar con el código y los datos.

## Requisitos

- Node 22+ (véase `engines` en `package.json`)

## Comandos

Los scripts están definidos en `package.json`. Tras `npm install`:

```bash
npm run dev          # http://localhost:4321
npm run validate     # esquemas, referencias y duplicados de data/
npm test             # Vitest
npm run check        # astro check (tipos y diagnósticos)
npm run build        # sitio estático en dist/
npm run preview      # sirve dist/
```

Ingestión: [`docs/ingestion.md`](docs/ingestion.md). Política editorial: [`docs/classification-policy.md`](docs/classification-policy.md). Arquitectura objetivo de la ingestión: [`docs/ingestion-v3-plan.md`](docs/ingestion-v3-plan.md).

```bash
npm run ingest:sync              # extrae las fuentes del registry, valida el lote y escribe
npm run ingest:sync -- --dry-run
npm run ingest:source -- auditorio-nacional
npm run ingest:promote -- ingestion/inbox/evento.json   # legacy: un candidato en disco
```

## Dónde están los datos

Los datos canónicos están versionados en Git, no en una base de datos:

```text
data/events/
data/venues/
data/organizers/
data/series/
data/sources/
```

Un catálogo vacío es válido. Cómo modelar y añadir eventos: [`docs/data-model.md`](docs/data-model.md).

Los ejemplos usados en tests viven en `tests/` (incluidas copias JSON en `tests/fixtures/`), no en `data/`.

Para previsualizar la UI con fixtures:

```bash
DATA_DIR=tests/fixtures/rich npm run dev
```

## Capas

La interfaz no lee JSON crudo. El flujo es:

```text
data/ + src/lib/schemas
        ↓
src/lib/repository
        ↓
src/lib/domain
        ↓
src/lib/presentation
        ↓
src/pages y src/components
```

Se puede sustituir la UI sin cambiar esquemas, validación ni consultas.

Los filtros de la agenda viven en la URL (`/?access=free&area=madrid`) y se aplican en el cliente sobre el listado estático generado en build, para no introducir SSR. El mismo script oculta las representaciones que ya han pasado respecto al reloj del navegador (`Europe/Madrid`), de modo que la agenda no depende de un deploy para dejar de mostrar un concierto terminado.

El resto de la semántica temporal sí se fija en el build: atajos `Hoy` / `Mañana` / `Fin de semana`, el placeholder cuando hoy no hay conciertos, `isPast` en las fichas de evento y los próximos conciertos de lugares. Cloudflare Pages reconstruye el sitio en cada push a `main`; además, un rebuild diario (`.github/workflows/daily-site-rebuild.yml`) dispara un Deploy Hook poco después de las 00:00 en Europe/Madrid para que esa presentación no se desfase un día sin cambios en Git.

## CI y publicación

Cada push a `main` y cada pull request ejecuta validación de datos, tests, typecheck y build (`.github/workflows/ci.yml`). El push directo a `main` está permitido. Cloudflare Pages despliega el sitio estático desde `main`.

El workflow diario no hace checkout ni build en GitHub: sólo hace `POST` al secret `CLOUDFLARE_PAGES_DEPLOY_HOOK_URL`. Configuración (una vez):

1. En Cloudflare Pages, abre el proyecto del sitio → Settings → Builds & deployments → Deploy hooks.
2. Crea un hook que apunte a la rama `main`.
3. Guarda la URL como secret de GitHub Actions `CLOUDFLARE_PAGES_DEPLOY_HOOK_URL`. No la subas al repositorio.

Para probarlo: Actions → Daily site rebuild → Run workflow (`workflow_dispatch`). El schedule se ejecuta una vez al día a las 00:15 con `timezone: Europe/Madrid`, ajustándose automáticamente entre CET y CEST.
