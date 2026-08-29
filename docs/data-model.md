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
- `slug` en kebab-case, único dentro de su colección. Una vez publicado un evento o un lugar, su slug es permanente. El ID tampoco cambia. No hay aliases ni redirects históricos: no se renombra un slug ya publicado.

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
- `kind`: contexto, no ranking de calidad. `established` | `alternative`
- `access`: `free` | `paid` | `unknown` (sin precios)
- `citations[]`: al menos una. `{ sourceId, url, checkedAt, externalId? }`
- `primarySourceId`: debe estar en `citations`
- `lastVerifiedAt`: `YYYY-MM-DD`, no anterior a ningún `checkedAt`

Un evento no puede publicarse sin procedencia. Si está `cancelled`, todas las representaciones deben estarlo.

En JSON-LD (`MusicEvent` por representación, alineado con Schema.org y Google Events): `scheduled` → `EventScheduled`, `cancelled` → `EventCancelled`, `postponed` → `EventPostponed`. Las representaciones canceladas se incluyen para expresar `EventCancelled`; no se omiten. Un evento aplazado conserva las fechas originales. No hay `EventRescheduled` todavía.

Una misma entidad `Event` solo agrupa `occurrences` cuando comparten los atributos musicales y contextuales esenciales. Cuando lugar, programa, reparto relevante o condiciones cambian sustancialmente, se consideran eventos separados. `Occurrence` permanece simple (`id`, `date`, `time`, `status`): no hay overrides por función. Varias funciones de una ópera o un programa repetido en las mismas condiciones son **un** evento. La agenda aplana esas representaciones en filas cronológicas.

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

`citations[].url` es la página que respalda ese evento. `checkedAt` es cuándo se comprobó. `externalId` es opcional: el identificador estable del evento en la fuente original cuando exista (texto no vacío). No vive a nivel de `Event`.

## Taxonomías

**Épocas (`eras`)**: `early`, `renaissance`, `baroque`, `classical`, `romantic`, `twentieth`, `contemporary`.

**Formatos (`formats`)**: `symphonic`, `chamber`, `recital`, `choral`, `organ`, `early-music`, `opera`, `zarzuela`, `lied`, `other`.

**Contexto (`kind`)** — no es calidad; dos valores excluyentes:

- `established`: programación profesional o estable dentro del circuito habitual de música clásica/cultural
- `alternative`: fuera de ese circuito estable, incluidas propuestas amateur, comunitarias, educativas o conciertos puntuales en espacios no dedicados habitualmente a programación musical

Un coro parroquial, una audición de escuela de música o un concierto ocasional en una iglesia no especializada son `alternative`. La temporada de un auditorio o un ciclo institucional estable es `established`.

**Series (`kind`)**: `festival`, `cycle`, `season`, `series`.

Los valores canónicos están en `src/lib/schemas/taxonomies.ts`. Las etiquetas en español están en la capa de presentación.

## Cómo añadir un evento

1. Crea o reutiliza venue, organizer, series y source en sus carpetas.
2. Añade `data/events/{id}.json` con al menos una representación y una citación.
3. Ejecuta `npm run validate`.
4. El harvesting determinista (v3 fase 1) es `npm run ingest:sync`. El camino manual de un candidato en disco sigue siendo `npm run ingest:promote` (ver [`docs/ingestion.md`](ingestion.md)). La arquitectura objetivo completa está en [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md).

No inventes eventos de producción. Los ejemplos de tests están en `tests/`, no en `data/`.

## Histórico

Los eventos pasados se conservan. La agenda lista presente y futuro (y el navegador oculta representaciones que ya hayan pasado desde el último build, en zona `Europe/Madrid`). Cada evento canónico tiene una página pública `/eventos/{slug}` que permanece tras haber pasado: `getStaticPaths()` no exige una representación futura.

Cada lugar publicado tiene una página `/lugares/{slug}` aunque ya no tenga representaciones futuras. El índice `/lugares` lista sólo espacios con próximos conciertos.
