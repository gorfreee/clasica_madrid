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

## CI

Cada push a `main` y cada pull request ejecuta validación de datos, tests, typecheck y build (`.github/workflows/ci.yml`). El push directo a `main` está permitido.
