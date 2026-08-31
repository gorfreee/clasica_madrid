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

Discovery v1 (fase 6, dos piezas): un comando determinista exporta un `DiscoveryContext` compacto para un agente externo con web search; el agente devuelve un `DiscoveryBatch` de hechos observados y el mismo pipeline lo normaliza, clasifica y reconcilia. No hay búsqueda web, scheduling ni promoción a adapters dentro de esta repo.

```text
registry → extract → hydrate → normalize → identity → classify → publication gate → reconcile → validate → write
```

- Un fallo de listing aísla esa fuente; el resto continúa.
- Un fallo de ficha de detalle es local al evento: se conservan los hechos del listing.
- La incorporación de March y el acceso HTTP vía fetch relay están en [validación de March](march-validation.md). GitHub-hosted Actions no alcanza de forma fiable `www.march.es` ni `teatrodelazarzuela.inaem.gob.es` en directo; `getText` sale por un fetch relay de Cloudflare (`vars.INGEST_FETCH_RELAY_URL` / `INGEST_FETCH_RELAY_TOKEN`) sólo para fuentes con `useFetchRelay` en el registry. Las URLs lógicas siguen siendo las oficiales. Reutiliza la protección de cobertura para adapters cuyo calendario depende de las fichas.
- En Zarzuela, las fichas son necesarias para el calendario y la sede: una cobertura severamente incompleta también marca fallo de source (etapa `hydration`), bloqueando auto-merge. Cualquier ficha necesaria fallida/no solicitada por circuito suprime las desapariciones de esa source; el report y el summary explicitan que no son evaluables. Las fechas del listing sólo sirven como hint para evitar hidratar obras enteramente fuera de ventana, nunca para generar funciones. Véase [validación del hardening de Zarzuela](zarzuela-hardening-validation.md).
- Clasificación: reglas deterministas y knowledge. El fallback de IA **sólo** decide eligibility si el determinista deja `uncertain`; un `include` o `exclude` determinista no se reabre. Si el resultado final es `include` y `eras`/`formats` siguen sin resolver, una segunda llamada puede completar esa taxonomía sin cambiar eligibility. Un fallo de taxonomía conserva el include.
- Identidad (sin fuzzy ni IA): `externalId` de la misma source → URL equivalente → alias explícito → coincidencia fuerte única (fecha, venue, título normalizado). Varios eventos publicados que comparten esa URL o `externalId` se tratan como una observación 1→N: se reparte el calendario si las fechas no solapan; si no hay asignación inequívoca se marcan todos como vistos sin escribir occurrences no asignables. `ambiguous` queda para colisiones reales (p. ej. coincidencia fuerte hacia eventos distintos, o fechas solapadas): no se crea ni se modifica.
- Publicación de eventos **nuevos**: sólo `include` se convierte en Candidate. `exclude` y `uncertain` no se publican, no consumen IDs/slugs y no se mezclan con los descartes estructurales. La fecha definitiva después de hidratar la ficha debe quedar dentro de la ventana de esa ejecución (por defecto hoy en Europe/Madrid → +120 días); si el listing parecía estar dentro y el detail produce una fecha fuera, es `fuera de ventana` y no se crea Candidate. Una ventana manual (`--from`/`--to`) no crea eventos históricos: la fecha sigue teniendo que ser ≥ hoy.
- Eventos **ya publicados**: se conservan `id` y `slug`. Una reclasificación posterior `exclude`/`uncertain` editorial no despublica; se registra como `classificationDrift`. Un `uncertain` por error técnico de IA (`ai-error`, timeout, rate-limit, output inválido, deferred o equivalente) no es drift: el caso queda `degraded`. Los hechos objetivos de la fuente (fecha, venue, status, citas, `lastVerifiedAt`) sí pueden actualizarse, incluida una reprogramación explícita fuera de la ventana.
- Merge de eventos publicados: `status`, `occurrences`, `venueId` (si hay match explícito) y citas se actualizan. `title`, `kind`, `eras`/`formats`, `performers`/`composers`/`works` se conservan si ya hay valor canónico; un incoming no vacío no sustituye esa información. `eras`/`formats` vacíos en el catálogo sí pueden rellenarse. Ante conflicto se preserva el valor publicado por completo. Un título solo tipográficamente equivalente no se considera desacuerdo. `organizerIds: []`, `seriesId: null` o `access: unknown` no borran. El desacuerdo se registra en `mergeDiagnostics` del report, no se aplica.
- Cancelación/aplazamiento: un evento nuevo ya cancelado no se crea; uno existente se actualiza. Un aplazamiento de una única representación conserva el occurrence ID.
- Desapariciones: `possiblyMissing` es sólo diagnóstico. Requiere source sana, evento futuro dentro de la ventana de esa ejecución y ningún match. Una source fallida no marca sus eventos. Los históricos no desaparecen.
- Deduplicación del lote: varias observaciones de la misma identidad se combinan; un conflicto material irresoluble no se escribe.
- Escritura atómica de creates y updates. Un fallo de prepare o commit restaura byte a byte cualquier archivo ya sustituido y no deja archivos nuevos a medias.
- Una reverificación que sólo cambia `event.lastVerifiedAt` y/o `citation.checkedAt` se trata como `unchanged` y **no** reescribe el JSON. La frescura queda en el report (`unchangedEvents`, `window`, `health`). Si hay algún cambio material, se escribe el evento completo con los timestamps de verificación actuales.
- Cada ejecución evalúa `health`: `clean` | `degraded` | `review` | `fatal`. `autoMergeEligible` es true sólo en `clean` y `degraded`. El workflow de producción consume exclusivamente estos campos machine-readable para decidir si falla, crea draft o permite auto-merge.

No están implementados (no los añadas salvo que una tarea pida esa fase): búsqueda web de discovery, scheduling de discovery, aprendizaje de sources ni reconciliación fuzzy. GitHub Actions no genera ni consume `DiscoveryContext`.

Las fuentes concretas, adapters, flags de CLI y detalles de matching viven en el código. No los dupliques aquí.

## Cómo ejecutarlo

```bash
npm run ingest:sync
npm run ingest:sync -- --dry-run
npm run ingest:sync -- --dry-run --report ingestion/reports/sync.json
npm run ingest:sync -- --from 2026-09-01 --to 2027-06-01 --sources auditorio-nacional,teatro-real
npm run ingest:source -- auditorio-nacional
npm run ingest:source -- auditorio-nacional --from 2026-09-01 --to 2027-06-01
npm run ingest:discovery -- ingestion/work/discovery-batch.json --dry-run
npm run ingest:discovery -- ingestion/work/discovery-batch.json --dry-run --from 2026-09-01 --to 2027-01-01
npm run ingest:discovery-context
npm run ingest:discovery-context -- --from 2026-09-01 --to 2027-01-01 --output ingestion/work/discovery-context.json
```

`--dry-run` valida y resume sin escribir el catálogo. `--data-dir` apunta a otro árbol (por defecto `data/` o `DATA_DIR`). `--report` escribe un JSON diagnóstico por evento (incluye `window`, `health`, `autoMergeEligible` y `healthReasons`); no cambia la clasificación ni qué se publica. `--observability-dir` escribe además `run.json` y el journal `events.jsonl`. Si hay `--report` y no se indica directorio, esos ficheros van junto al report. `ingestion/reports/` está gitignorado.

Sin `--from`/`--to`, la ventana es hoy en Europe/Madrid → +120 días. Si se indica uno, hay que indicar ambos. Un rango manual no tiene tope de 120 días. Sin `--sources`, `ingest:sync` ejecuta las fuentes del registry que no marcan `skipDefaultSync`. `ingest:source` y `--sources` explícitos siguen ejecutando cualquier fuente del registry, incluida una marcada así, y un fallo sigue siendo un fallo.

## Discovery v1

El harvesting cubre fuentes del registry. Discovery cubre lo que todavía no tiene adapter: una parroquia, un conservatorio, un concierto puntual. Un agente (Cursor, ChatGPT u otro, con web search) busca fuera; el código de ingestión no navega la web.

Hay dos piezas, y sólo esas:

1. **Contexto.** `npm run ingest:discovery-context` vuelca un `DiscoveryContext` JSON compacto: ventana (por defecto la misma de Ingestion v3: hoy en Europe/Madrid → +120 días), sources harvesteadas y canónicas ya conocidas, venues, fingerprints de eventos cuya representación intersecta la ventana, un resumen editorial estable y reglas breves de evidencia. Sirve para que el agente evite rebuscar Teatro Real / Auditorio / March y reconozca un redescubrimiento. No es la Classification Policy ejecutable ni un volcado del catálogo.
2. **Import.** El agente escribe un `DiscoveryBatch` de **hechos observados** (título, fechas, URL que respalda el evento, venue, intérpretes/obras si la fuente los declara). No entrega `eligibility`, `kind`, `formats`, `eras`, slugs ni Candidates canónicos. `npm run ingest:discovery` lo pasa al pipeline común, que clasifica y publica exactamente como en harvesting.

El `DiscoveryContext` es input del agente. El `DiscoveryBatch` es output del agente, no una cola de producción. Forma conceptual:

```text
npm run ingest:discovery-context → DiscoveryContext JSON
        → agente externo (web search)
        → DiscoveryBatch JSON
        → npm run ingest:discovery → normalize → classify → reconcile → Candidate → data/**
```

`--output` escribe el contexto donde se indique (p. ej. `ingestion/work/`, gitignorado). Sin `--output`, el JSON va a stdout. El comando no escribe en `data/**`.

- cada observación necesita una URL http(s) que respalde los hechos; sin URL no se publica;
- `foundVia` (p. ej. una URL de búsqueda) es trazabilidad interna: no es source canónica ni `primarySource`;
- una source descubierta no entra en el registry ni recibe adapter; si el Candidate se publica y esa source no está en `data/sources`, el batch existente la incorpora;
- un venue nuevo sólo se crea con name + municipality + area coherentes; si el nombre coincide exactamente con un lugar del catálogo, se reutiliza; no hay fuzzy matching;
- discovery no evalúa `possiblyMissing`: una observación puntual no demuestra la cobertura de una source.

`ingest:promote` sigue siendo el import manual de Candidates ya interpretados. Discovery no lo usa: el agente no debe saltarse classification.

CI no llama a un LLM ni lanza web search. Tests inyectan fakes. No hay workflow de GitHub Actions que genere el contexto, busque en la web ni importe un batch de discovery de forma programada.

## IA

El fallback es opcional y provider-agnóstico. La CLI crea como máximo un classifier por ejecución (`createAiClassifierFromEnv()`). Sin credenciales, timeout o respuesta inválida, el caso permanece `uncertain` y el lote continúa.

`ingest:sync` / `ingest:source` / `ingest:discovery` cargan `.local/ai.env` (gitignorado) si existe; el entorno del proceso gana. Plantilla y variables: `.env.example`. No commits ni imprimas la clave.

El estado local (caché, cuota, pendientes, lock) vive bajo `.local/ai/` por defecto, fuera de Git y de `data/`. `--dry-run` no escribe el catálogo, pero sí puede gastar cuota y guardar ese estado. No hay rotación de claves ni coordinación entre máquinas: Google limita por proyecto y modelo.

Flags `--ai-*` (modelo, sin caché, tope de requests) existen para pruebas acotadas. Requieren Gemini. Los tests ordinarios no las necesitan.

## Automatización en GitHub Actions

`.github/workflows/ingestion.yml` serializa todas las ejecuciones en el concurrency group `ingestion-production`; una scheduled y una manual nunca comparten simultáneamente cuota ni state de Gemini.

`fundacion-juan-march` y `teatro-zarzuela` forman parte del `all` programado y salen por el fetch relay (`useFetchRelay`). Un `March HTTP diagnostic` (dispatch, ubuntu + macOS, group propio) comprueba el listing de March **en directo**, sin relay; no escribe `data/**`. Ver [validación de March](march-validation.md) e [infra/fetch-relay](../infra/fetch-relay/README.md). El Worker se despliega con [deploy-fetch-relay.yml](../.github/workflows/deploy-fetch-relay.yml) o desde el Dashboard; añadir otra fuente al relay es `useFetchRelay: true` en el registry. El hardening de Zarzuela (pacing, retry, circuito, cobertura) permanece; el relay sólo cambia el egress.

### Scheduled

Se ejecuta los días 1, 11 y 21 de cada mes a las 09:17 de `Europe/Madrid`, siempre en modo publish, contra todas las sources y con la ventana por defecto de hoy a +120 días.

### Manual

En **Actions → Production ingestion → Run workflow**:

- `mode`: `dry-run` (default) o `publish`;
- `sources`: `all` o uno o varios IDs separados por coma;
- `from` y `to`: rango opcional; deben informarse juntos;
- `auto_merge`: opt-in adicional para un publish manual;
- `ai_max_requests`: presupuesto HTTP opcional para Gemini.

El dry-run usa el ref seleccionado en «Run workflow» y nunca puede modificar `data/**` ni crear una PR. `schedule` y `publish` ejecutan siempre el código de `main`, de modo que una rama no fusionada no puede escribir el catálogo. En publish, un no-op tampoco crea branch, commit ni PR. Si ya existe una PR abierta cuyo branch empieza por `automation/ingestion-`, la ejecución conserva su report pero no crea ni actualiza otra PR.

### Secrets, variables y permisos

- secret `GEMINI_API_KEY`: key del proyecto de Google AI Studio;
- secret `INGESTION_BOT_TOKEN`: token fine-grained con acceso a esta repo para Contents read/write, Pull requests read/write y Actions read. Se usa para push, creación de PR y auto-merge, de modo que el evento `pull_request` dispare CI;
- secret `INGEST_FETCH_RELAY_TOKEN`: Bearer del Worker de Cloudflare usado como egress;
- repository variable `INGEST_FETCH_RELAY_URL`: URL del Worker (no es sensible). El pipeline sólo la usa para fuentes con `useFetchRelay` en el registry. Ausentes, el resto de fuentes no cambia; las fuentes con `useFetchRelay` fallan de forma visible, también dentro del `all` programado;
- repository variable `INGESTION_AUTO_MERGE_ENABLED`: kill switch global; sólo el valor exacto `true` habilita auto-merge.

El state persistente recupera `quota.json`, `cache/**` y `pending/**` mediante `actions/cache`. Cada run guarda una key inmutable y restaura la más reciente; `run.lock` nunca se persiste. Cada ejecución sube un artifact de observabilidad (`ingestion-run-<run_id>-<attempt>`) con retención de 90 días, incluso si la ingestión falla. Ese bundle no se commitea. El estado persistente de Gemini (`.local/ai/`) no forma parte del artifact.

### Dónde está una run

1. Job Summary de la ejecución (métricas, health, estado final, nombre del artifact).
2. Logs nativos de Actions (interfaz principal para ver el progreso en caliente).
3. Artifact `ingestion-run-<run_id>-<attempt>`:

| Fichero | Qué es |
|---|---|
| `run.json` | Manifest de la ejecución: modo, ventana, sources, status (`completed` / `failed` / `interrupted`), último stage, fallo sanitizado. |
| `report.json` | Resultado canónico machine-readable cuando el pipeline termina (o un fatal/interrupted stub si no pudo). Decisiones finales por evento, con hechos de listing/observed/normalized. |
| `events.jsonl` | Journal incremental. Una línea JSON por observación, decisión o fallo de fuente. Sobrevive a un corte a mitad de run. |
| `run.log` | stdout/stderr de `npm run ingest:sync` (el exit code real se conserva con `pipefail`). |

`report.json` es el resumen final. `events.jsonl` es la evidencia forense incremental: no es event sourcing ni trazas `STARTED`/`FINISHED`.

El Job Summary no es un dashboard. El detalle por evento vive en el artifact.

### Cómo investigar una run fallida

Empieza por el Job Summary (estado, último stage, motivo conciso) y descarga el artifact. `run.json` dice si fue `failed` o `interrupted` y en qué stage. `events.jsonl` conserva lo ya procesado. `report.json` está cuando el proceso pudo escribirlo. Los logs de Actions siguen siendo la interfaz inmediata; `run.log` hace que el artifact sea autocontenido para un agente.

`SIGINT`/`SIGTERM` (cancelación o timeout de Actions) se tratan como `interrupted`: se flushea el journal, se actualiza `run.json`, se libera el lock de Gemini y se sale 130/143. **`SIGKILL` no es interceptable**; si el runner mata el proceso, el journal puede perder las últimas líneas no flusheadas.

Preguntas útiles para un agente con el bundle:

```text
Revisa todos los uncertain y dime cuáles parecen falsos negativos.

Haz un muestreo estratificado de includes/excludes y busca errores editoriales.

Busca anomalías en performers/composers/works agrupadas por source.

Explícame la trazabilidad completa del evento X.

Compara dos run artifacts e identifica regresiones.
```

La trazabilidad por evento en `report.json` sigue `listing → observed → normalized → classification → identity → candidate`. Sirve para distinguir si un performer salió del adapter, de la hidratación de ficha, de la normalización o del merge.

### Observabilidad frente a estado persistente de Gemini

| Qué | Dónde | Para qué |
|---|---|---|
| Artifact de la run | Actions artifact, 90 días | Entender esa ejecución |
| `quota.json`, `cache/**`, `pending/**` | `.local/ai/` vía `actions/cache` | Operar Gemini en la siguiente run |

No conviertas el state de Gemini en historial de runs ni lo metas en el artifact.

`--observability-dir` (o, si sólo hay `--report`, el directorio del report) escribe `run.json` y `events.jsonl` en local. El flag no cambia clasificación ni publicación.

### Publicación y recovery

- `fatal`: falla el workflow y no crea PR;
- `review`: sin cambios sólo avisa; con cambios crea una draft PR y nunca activa auto-merge;
- `clean` / `degraded`: con cambios crea una PR normal. El scheduled solicita auto-merge si el kill switch está activo; el manual publish necesita además `auto_merge=true`;
- antes de solicitar squash auto-merge, el workflow espera la ejecución `pull_request` real de `ci.yml` para el SHA publicado y exige que termine verde.

Ante un fallo, empieza por el Job Summary y el artifact de observabilidad. Si hay una PR de ingestión abierta, revísala y fusiónala o ciérrala antes de reintentar. Si el token expiró, rota `INGESTION_BOT_TOKEN`. Si el state restaurado está corrupto, no reinicies contadores a ciegas: conserva o recupera `quota.json`, o espera al siguiente reset diario antes de retirar el cache afectado. Un rerun es seguro porque no reutiliza `run.lock` y la reconciliación filtra reverificaciones sin cambios materiales.

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
