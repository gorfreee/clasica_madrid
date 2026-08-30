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

Harvesting de fuentes conocidas y automatización de producción (fases 1–4 del plan v3): extraer, hidratar fichas cuando el adapter lo soporta, normalizar, resolver identidad, clasificar y reconciliar contra el catálogo; después, publicar cambios materiales mediante PR y CI.

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
- Cada ejecución evalúa `health`: `clean` | `degraded` | `review` | `fatal`. `autoMergeEligible` es true sólo en `clean` y `degraded`. El workflow de producción consume exclusivamente estos campos machine-readable para decidir si falla, crea draft o permite auto-merge.

No están implementados (no los añadas salvo que una tarea pida esa fase): discovery automático ni reconciliación fuzzy.

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

## Automatización en GitHub Actions

`.github/workflows/ingestion.yml` serializa todas las ejecuciones en el concurrency group `ingestion-production`; una scheduled y una manual nunca comparten simultáneamente cuota ni state de Gemini.

### Scheduled

Se ejecuta los días 1, 11 y 21 de cada mes a las 09:17 de `Europe/Madrid`, siempre en modo publish, contra todas las sources y con la ventana por defecto de hoy a +120 días.

### Manual

En **Actions → Production ingestion → Run workflow**:

- `mode`: `dry-run` (default) o `publish`;
- `sources`: `all` o uno o varios IDs separados por coma;
- `from` y `to`: rango opcional; deben informarse juntos;
- `auto_merge`: opt-in adicional para un publish manual;
- `ai_max_requests`: presupuesto HTTP opcional para Gemini.

El dry-run nunca puede modificar `data/**` ni crear una PR. En publish, un no-op tampoco crea branch, commit ni PR. Si ya existe una PR abierta cuyo branch empieza por `automation/ingestion-`, la ejecución conserva su report pero no crea ni actualiza otra PR.

### Secrets, variable y permisos

- secret `GEMINI_API_KEY`: key del proyecto de Google AI Studio;
- secret `INGESTION_BOT_TOKEN`: token fine-grained con acceso a esta repo para Contents read/write, Pull requests read/write y Actions read. Se usa para push, creación de PR y auto-merge, de modo que el evento `pull_request` dispare CI;
- repository variable `INGESTION_AUTO_MERGE_ENABLED`: kill switch global; sólo el valor exacto `true` habilita auto-merge.

El state persistente recupera `quota.json`, `cache/**` y `pending/**` mediante `actions/cache`. Cada run guarda una key inmutable y restaura la más reciente; `run.lock` nunca se persiste. Los reports se suben siempre que existan como artifacts con 90 días de retención y nunca se commitean.

### Publicación y recovery

- `fatal`: falla el workflow y no crea PR;
- `review`: sin cambios sólo avisa; con cambios crea una draft PR y nunca activa auto-merge;
- `clean` / `degraded`: con cambios crea una PR normal. El scheduled solicita auto-merge si el kill switch está activo; el manual publish necesita además `auto_merge=true`;
- antes de solicitar squash auto-merge, el workflow espera la ejecución `pull_request` real de `ci.yml` para el SHA publicado y exige que termine verde.

Ante un fallo, empieza por el Job Summary y el artifact JSON. Si hay una PR de ingestión abierta, revísala y fusiónala o ciérrala antes de reintentar. Si el token expiró, rota `INGESTION_BOT_TOKEN`. Si el state restaurado está corrupto, no reinicies contadores a ciegas: conserva o recupera `quota.json`, o espera al siguiente reset diario antes de retirar el cache afectado. Un rerun es seguro porque no reutiliza `run.lock` y la reconciliación filtra reverificaciones sin cambios materiales.

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

`ci.yml` valida, testea, typecheckea y construye todas las PRs sin llamar a Gemini. El workflow de ingestión no duplica esa CI: sólo ejecuta el pipeline, comprueba que el working tree no tenga cambios fuera de `data/**`, crea la PR y, cuando corresponde, espera el CI normal antes de solicitar squash auto-merge.
