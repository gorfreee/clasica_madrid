# Modelo de datos v1

Los datos canónicos viven en `data/` y se validan con Zod (`src/lib/schemas`). Un fichero JSON por entidad, llamado `{id}.json`. El catálogo vacío es válido.

## Entidades

| Carpeta | Prefijo de ID | Qué es |
|---|---|---|
| `data/events/` | `evt_` | Evento musical (puede tener varias representaciones) |
| `data/venues/` | `ven_` | Lugar |
| `data/organizers/` | `org_` | Organizador |
| `data/series/` | `ser_` | Festival, ciclo, temporada o serie |
| `data/sources/` | `src_` | Fuente reutilizable (sitio, agregador, etc.) |

Intérpretes, compositores y obras **no** son entidades propias en v1: van embebidos en el evento. Así se puede publicar sin un catálogo previo de repertorio, y más adelante se pueden promover a entidades si hace falta.

## Identificadores y slugs

- IDs estables, ASCII, con prefijo: `evt_carmen_2026`.
- El nombre del fichero debe coincidir con el ID: `evt_carmen_2026.json`.
- `slug` en kebab-case, único dentro de su colección. Puede cambiar; el ID no.

## Evento

Campos principales:

- `schemaVersion`: `1`
- `id`, `slug`, `title`
- `status`: `scheduled` | `cancelled` | `postponed`
- `venueId` (obligatorio)
- `organizerIds` (puede ser `[]`)
- `seriesId` (o `null`)
- `occurrences[]`: `{ id, date, time, status }`
  - `date` en `YYYY-MM-DD` (calendario real)
  - `time` en `HH:mm` (zona `Europe/Madrid`) o `null` si se desconoce
  - `status`: `scheduled` | `cancelled`
- `performers[]`: `{ name, role? }` (`orchestra`, `choir`, `ensemble`, `conductor`, `soloist`, `other`)
- `composers[]`: `{ name }`
- `works[]`: `{ title, composerName? }` (opcional, puede ir vacío)
- `eras[]`, `formats[]` (taxonomías; pueden ir vacíos si aún no hay clasificación)
- `kind`: contexto, no ranking de calidad
- `access`: `free` | `paid` | `unknown` (sin precios)
- `citations[]`: al menos una. `{ sourceId, url, checkedAt }`
- `primarySourceId`: debe estar en `citations`
- `lastVerifiedAt`: `YYYY-MM-DD`, no anterior a ningún `checkedAt`

Un evento no puede publicarse sin procedencia. Si está `cancelled`, todas las representaciones deben estarlo.

Varias funciones de una ópera o un programa repetido son **un** evento con varias `occurrences`. La agenda aplana esas representaciones en filas cronológicas.

## Lugar

- `municipality`: texto libre (p. ej. `Madrid`, `Alcobendas`)
- `area`: `madrid` (municipio de Madrid) o `nearby` (municipio próximo integrado en la experiencia)
- `address` y `url` opcionales

No hay lista cerrada de municipios del área metropolitana. Si `municipality` es Madrid, `area` debe ser `madrid`, y al revés.

## Fuente

La entidad `sources/` describe el origen (nombre, tipo, URL de la sede). Cada evento cita una página concreta:

- `official`: web o canal del organizador, espacio o institución
- `aggregator`: agenda de terceros
- `secondary`: prensa, redes, mención indirecta

`citations[].url` es la página que respalda ese evento. `checkedAt` es cuándo se comprobó.

## Taxonomías

**Épocas (`eras`)**: `early`, `renaissance`, `baroque`, `classical`, `romantic`, `twentieth`, `contemporary`.

**Formatos (`formats`)**: `symphonic`, `chamber`, `recital`, `choral`, `organ`, `early-music`, `opera`, `zarzuela`, `lied`, `other`.

**Contexto (`kind`)** — no es calidad:

- `institutional`: grandes instituciones / programación principal
- `independent`: alternativa o independiente
- `amateur`: amateur
- `community`: comunitaria / hiperlocal
- `educational`: formativa / estudiantil

Un coro parroquial puede ser `community` o `amateur`. Una audición infantil de escuela de música, si se incluye, sería `educational`; no es contenido principal por defecto.

**Series (`kind`)**: `festival`, `cycle`, `season`, `series`.

Los valores canónicos están en `src/lib/schemas/taxonomies.ts`. Las etiquetas en español están en la capa de presentación.

## Cómo añadir un evento

1. Crea o reutiliza venue, organizer, series y source en sus carpetas.
2. Añade `data/events/{id}.json` con al menos una representación y una citación.
3. Ejecuta `npm run validate`.
4. Si el cambio es de ingestión automática, usa el formato candidato y `npm run ingest:promote` (ver `docs/ingestion.md`).

No inventes eventos de producción. Los ejemplos de tests están en `tests/`, no en `data/`.

## Histórico

Los eventos pasados se conservan. La web pública lista presente y futuro; las páginas individuales se generan sólo para eventos con alguna representación activa próxima.
