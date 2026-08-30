# Ingestión de eventos

Puerta de entrada operativa: qué hay implementado y cómo ejecutarlo.

| Qué necesitas | Dónde |
|---|---|
| Diseño objetivo (hacia dónde evolucionar) | [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md) |
| Política editorial de clasificación | [`docs/classification-policy.md`](classification-policy.md) |
| Modelo de datos canónico | [`docs/data-model.md`](data-model.md) |
| Código del pipeline | `src/ingestion/` |
| Registry de fuentes | `src/ingestion/registry.ts` |
| Prompt del fallback de IA | `src/ingestion/classification/ai-prompt.ts` |
| Golden evaluation set | `tests/fixtures/ingestion/golden/` |
| Variables de entorno de IA | `.env.example` |
| Histórico (no es requisito vigente) | [`docs/archive/`](archive/) |

La web no escribe datos. Todo lo publicado entra por Git, pasa validación determinista y CI, y entonces se fusiona.

## Qué hay implementado

Harvesting de fuentes conocidas (fases 1–3 del plan v3): extraer, hidratar fichas cuando el adapter lo soporta, normalizar, resolver identidad, clasificar y reconciliar contra el catálogo.

```text
registry → extract → hydrate → normalize → identity → classify → publication gate → reconcile → validate → write
```

- Un fallo de listing aísla esa fuente; el resto continúa.
- Un fallo de ficha de detalle es local al evento: se conservan los hechos del listing.
- Clasificación: reglas deterministas y knowledge, con fallback de IA **sólo** si el determinista deja `uncertain`. Un `include` o `exclude` determinista no se reabre.
- Identidad (sin fuzzy ni IA): `externalId` de la misma source → URL equivalente → alias explícito → coincidencia fuerte única (fecha, venue, título normalizado). Si hay más de un match plausible, el caso es `ambiguous`: no se crea ni se modifica.
- Publicación de eventos **nuevos**: sólo `include` se convierte en Candidate. `exclude` y `uncertain` no se publican, no consumen IDs/slugs y no se mezclan con los descartes estructurales. La fecha definitiva después de hidratar la ficha debe quedar dentro de la ventana de esa ejecución (por defecto hoy en Europe/Madrid → +120 días); si el listing parecía estar dentro y el detail produce una fecha fuera, es `fuera de ventana` y no se crea Candidate. Una ventana manual (`--from`/`--to`) no crea eventos históricos: la fecha sigue teniendo que ser ≥ hoy.
- Eventos **ya publicados**: se conservan `id` y `slug`. Una reclasificación posterior `exclude`/`uncertain` no despublica; se registra como `classificationDrift`. Los hechos objetivos de la fuente (fecha, venue, status, citas, `lastVerifiedAt`) sí pueden actualizarse, incluida una reprogramación explícita fuera de la ventana.
- Merge de eventos publicados: `status`, `occurrences`, `venueId` (si hay match explícito) y citas se actualizan. `title`, `kind`, `eras`/`formats`, `performers`/`composers`/`works` se conservan si ya hay valor canónico; un incoming no vacío no sustituye esa información. `eras`/`formats` vacíos en el catálogo sí pueden rellenarse. Ante conflicto se preserva el valor publicado por completo. Un título solo tipográficamente equivalente no se considera desacuerdo. `organizerIds: []`, `seriesId: null` o `access: unknown` no borran. El desacuerdo se registra en `mergeDiagnostics` del report, no se aplica.
- Cancelación/aplazamiento: un evento nuevo ya cancelado no se crea; uno existente se actualiza. Un aplazamiento de una única representación conserva el occurrence ID.
- Desapariciones: `possiblyMissing` es sólo diagnóstico. Requiere source sana, evento futuro dentro de la ventana de esa ejecución y ningún match. Una source fallida no marca sus eventos. Los históricos no desaparecen.
- Deduplicación del lote: varias observaciones de la misma identidad se combinan; un conflicto material irresoluble no se escribe.
- Escritura atómica de creates y updates. Un fallo de prepare o commit restaura byte a byte cualquier archivo ya sustituido y no deja archivos nuevos a medias.
- Una reverificación que sólo cambia `event.lastVerifiedAt` y/o `citation.checkedAt` se trata como `unchanged` y **no** reescribe el JSON. La frescura queda en el report (`unchangedEvents`, `window`, `health`). Si hay algún cambio material, se escribe el evento completo con los timestamps de verificación actuales.
- Cada ejecución evalúa `health`: `clean` | `degraded` | `review` | `fatal`. `autoMergeEligible` es true sólo en `clean` y `degraded`. Los workflows de GitHub y el auto-merge aún no existen.

No están implementados (no los añadas salvo que una tarea pida esa fase): discovery automático, reconciliación fuzzy, GitHub Actions de ingestión ni auto-merge.

Las fuentes concretas, adapters, flags de CLI y detalles de matching viven en el código. No los dupliques aquí.

## Cómo ejecutarlo

```bash
npm run ingest:sync
npm run ingest:sync -- --dry-run
npm run ingest:sync -- --dry-run --report ingestion/reports/sync.json
npm run ingest:sync -- --from 2026-09-01 --to 2027-06-01 --sources auditorio-nacional,teatro-real
npm run ingest:source -- auditorio-nacional
npm run ingest:source -- auditorio-nacional --from 2026-09-01 --to 2027-06-01
```

`--dry-run` valida y resume sin escribir el catálogo. `--data-dir` apunta a otro árbol (por defecto `data/` o `DATA_DIR`). `--report` escribe un JSON diagnóstico por evento (incluye `window`, `health`, `autoMergeEligible` y `healthReasons`); no cambia la clasificación ni qué se publica. `ingestion/reports/` está gitignorado.

Sin `--from`/`--to`, la ventana es hoy en Europe/Madrid → +120 días. Si se indica uno, hay que indicar ambos. Un rango manual no tiene tope de 120 días. Sin `--sources`, `ingest:sync` ejecuta todas las fuentes del registry. `ingest:source` es el atajo de una sola fuente y comparte el mismo `runIngest`.

CI no llama a un LLM. Tests inyectan fakes.

## IA

El fallback es opcional y provider-agnóstico. La CLI crea como máximo un classifier por ejecución (`createAiClassifierFromEnv()`). Sin credenciales, timeout o respuesta inválida, el caso permanece `uncertain` y el lote continúa.

`ingest:sync` / `ingest:source` cargan `.local/ai.env` (gitignorado) si existe; el entorno del proceso gana. Plantilla y variables: `.env.example`. No commits ni imprimas la clave.

El estado local (caché, cuota, pendientes, lock) vive bajo `.local/ai/` por defecto, fuera de Git y de `data/`. `--dry-run` no escribe el catálogo, pero sí puede gastar cuota y guardar ese estado. No hay rotación de claves ni coordinación entre máquinas: Google limita por proyecto y modelo.

Flags `--ai-*` (modelo, sin caché, tope de requests) existen para pruebas acotadas. Requieren Gemini. Los tests ordinarios no las necesitan.

## Candidatos JSON (legacy)

Camino manual durante la migración, no la arquitectura objetivo:

```bash
npm run ingest:promote -- ingestion/inbox/evento.json
```

El candidato usa el esquema de `src/lib/schemas/candidate.ts`. El script valida, fusiona en memoria con `data/` y, si todo es correcto, escribe ficheros nuevos. No sobrescribe un evento existente. Si el candidato trae una entidad cuyo ID ya está en el catálogo, debe coincidir campo a campo.

Directorios de trabajo gitignorados: `ingestion/inbox/`, `ingestion/work/`, `ingestion/rejected/`, `ingestion/reports/`.

En el diseño v3 los candidatos del flujo automático existen en memoria. `ingestion/inbox/` queda para imports manuales, debugging y casos excepcionales.

Un agente puede descubrir, extraer y clasificar. Nunca debe saltarse la validación ni escribir directo en `data/` de producción.

## CI

La CI actual (`.github/workflows/ci.yml`) valida, testea, typecheckea y construye. No aprueba PRs ni fusiona sola. Branch protection, required checks y workflows de ingestión forman parte del *objetivo* v3, no de la implementación actual.
