# Clásica Madrid

Agenda pública de conciertos y eventos de música clásica en Madrid y su entorno inmediato.

El producto y su alcance están en [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md). Las decisiones de arquitectura están en [`ARCHITECTURE.md`](ARCHITECTURE.md). Este README cubre cómo trabajar con el código y los datos.

## Requisitos

- Node 22+

## Comandos

```bash
npm install
npm run dev          # http://localhost:4321
npm run validate     # esquemas, referencias y duplicados de data/
npm test             # Vitest (lógica de dominio y validación)
npm run check        # Astro + TypeScript
npm run build        # check + sitio estático en dist/
npm run preview      # sirve dist/
```

Ingestión de un candidato (ver [`docs/ingestion.md`](docs/ingestion.md)):

```bash
npm run ingest:promote -- ingestion/inbox/evento.json
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

Hoy el catálogo de producción está vacío a propósito: la web muestra un estado vacío válido. Cómo modelar y añadir eventos: [`docs/data-model.md`](docs/data-model.md).

Los ejemplos usados en tests viven en `tests/`, no en `data/`.

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

## CI

Cada push y pull request ejecuta instalación, validación de datos, tests, typecheck y build (`.github/workflows/ci.yml`).
