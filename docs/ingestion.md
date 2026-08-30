# Ingestión de eventos

Este documento es la **puerta de entrada operativa** a la ingestión: qué hay implementado hoy y hacia dónde ir.

No es la especificación de arquitectura objetivo.

| Qué necesitas | Dónde |
|---|---|
| Diseño objetivo vigente (fuente de verdad para evolucionar la ingestión) | [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md) |
| Estado operativo actual (este documento) | `docs/ingestion.md` |
| Classification Policy v1 y criterios de Phase 2 | [`docs/classification-policy.md`](classification-policy.md) |
| Prompt versionado del fallback de IA | [`src/ingestion/classification/ai-prompt.ts`](../src/ingestion/classification/ai-prompt.ts) |
| Acceptance real de Phase 2 (dry-run 2026-08-29) | [`docs/ingestion-phase2-acceptance.md`](ingestion-phase2-acceptance.md) |
| Rebaseline editorial del catálogo legacy | [`docs/catalog-rebaseline-audit.md`](catalog-rebaseline-audit.md) |
| Golden evaluation set | [`tests/fixtures/ingestion/golden/`](../tests/fixtures/ingestion/golden/) |
| Modelo de datos canónico | [`docs/data-model.md`](data-model.md) |
| Investigación y planes anteriores (histórico, no requisitos) | [`docs/archive/`](archive/) |

La web no escribe datos. Todo lo publicado entra por Git, pasa validación determinista y CI, y entonces se fusiona.

## Estado actualmente implementado

Hay dos caminos. El harvesting determinista de la **v3 (fases 1 y 2)** es el que hay que usar para extraer fuentes conocidas. El flujo de candidatos JSON en disco sigue existiendo como herramienta manual durante la migración.

### Harvesting v3 (fases 1 y 2)

Código en `src/ingestion/`. Ejecución local:

```bash
npm run ingest:sync
npm run ingest:sync -- --dry-run
npm run ingest:sync -- --dry-run --report ingestion/reports/sync.json
npm run ingest:source -- auditorio-nacional
npm run ingest:source -- teatro-real --dry-run --report ingestion/reports/teatro-real.json
```

Flujo:

1. Carga el source registry (`src/ingestion/registry.ts`).
2. Ejecuta cada adapter y obtiene `RawEvent[]` del listing.
3. Aísla fuentes fallidas; las sanas siguen.
4. Hidrata fichas de detalle cuando el adapter implementa `hydrate` (Auditorio Nacional y Teatro Real). Un fallo de ficha (404, 403, HTML inesperado) es local al evento: se conservan los hechos del listing. Si la ficha declara de forma explícita fecha, hora, venue o estado (aplazamiento/cancelación), esos hechos sustituyen al listing. Una fecha de aplazamiento futura se conserva aunque quede fuera de la ventana de discovery del listing. Un evento explícitamente cancelado no se publica como activo. Madrid Datos no hidrata: el JSON-LD ya trae los hechos disponibles.
5. Normaliza hechos (textos, fechas, horas, URLs, performers/composers/works observados). Las URLs usadas en identidad, citas y matching ignoran trailing slash, fragment y casing del hostname; no se eliminan query params.
6. Proyecta `NormalizedEvent → ObservedFacts` (sin `sourceId`, `sourceUrl`, `externalId` ni occurrences) y clasifica con `classifyObserved()`: reglas deterministas, knowledge, y fallback de IA **sólo** si el resultado es `uncertain`.
7. Puerta de publicación: `include` puede continuar hacia Candidate; `exclude` y `uncertain` no se publican, no consumen IDs/slugs y no se mezclan con los descartes estructurales. El Candidate usa `formats`, `eras`, `kind` y `access` del `ClassificationResult`. `kind` no proviene de la source (`provisionalKind` ya no existe). Un `include` con `eras=[]` / `formats=[]` sigue siendo publicable. Roles de intérprete se asignan sólo cuando `roleText` es inequívoco.
8. Construye y valida el lote completo.
9. Escribe sólo archivos nuevos, primero a un temporal y después al destino. Un fallo no deja el lote a medias. No actualiza ni borra eventos ya publicados.
10. Imprime un resumen (fuentes, RawEvents, hidratación, clasificación include/exclude/uncertain, uso de IA, descartes estructurales, candidatos, escritos).
11. Si se pasa `--report <ruta>`, escribe además un JSON diagnóstico por evento observado (ver [Report por evento](#report-por-evento)).

Una segunda ejecución inmediata contra los mismos inputs no debe escribir cambios canónicos.

Fuentes de la fase 1:

| id | Input | Adapter |
|---|---|---|
| `auditorio-nacional` | JSON FullCalendar `front-page-events.json` | JSON |
| `teatro-real` | HTML del calendario `/es/calendario` | HTML custom |
| `madrid-datos` | JSON-LD abierto `206974-0-agenda-eventos-culturales-100` | JSON-LD (sólo `@type` Música, con fecha, hora y lugar) |

`--dry-run` valida y resume sin escribir el catálogo (la IA sí puede guardar estado local). `--data-dir` apunta a otro árbol (por defecto `data/` o `DATA_DIR`). `--report <ruta>` escribe un JSON diagnóstico de la ejecución; no cambia la clasificación ni qué se publica. La CLI rechaza flags desconocidas, `--data-dir` o `--report` sin ruta, fuentes inexistentes y combinaciones incorrectas de argumentos.

Un adapter que reconoce la estructura general pero no consigue interpretar ningún evento (extracción vacía sospechosa) falla de forma visible; esa fuente se aísla y las demás continúan. Un calendario genuinamente vacío no es un error.

No hay GitHub Actions de ingestión ni auto-merge. Un evento nuevo se publica sólo si la clasificación final es `include` y los datos estructurales (fecha futura publicable, lugar reconocible) son válidos. Las fechas del listing siguen acotadas a la ventana de discovery; una fecha que la ficha sustituye de forma explícita puede quedar fuera de esa ventana y aun así publicarse si es futura. Un evento cancelado no se publica. `exclude` no se publica. `uncertain` no se publica (tampoco como include de baja confianza). Sin provider/credenciales de IA, con timeout o respuesta inválida, el fallback degrada a `uncertain` y el resto del lote continúa. CI no llama a un LLM: `runIngest` recibe un `AiClassifier` inyectado por la CLI (`createAiClassifierFromEnv()`). `eras`, `works`, `composers` y `formats` vacíos no bloquean un `include`. `kind` sale del classifier, no de la source. Performers, composers y works se copian cuando la ficha los declara de forma razonable; el rol canónico sólo se asigna si `roleText` es inequívoco. Sólo se publica si el lugar se reconoce de forma inequívoca (catálogo, alias globales, o alias **source-aware**). «Sala Principal» no es un alias global: sólo resuelve a Teatro Real cuando `sourceId=teatro-real`. Madrid Datos puede resolver un centro municipal ya publicado por nombre exacto, por sufijo de distrito `(Retiro)` u otro entre paréntesis al final, o por el id numérico de `relation.@id` cuando está mapeado a un venue canónico. Un facility municipal sin mapeo ni nombre inequívoco sigue siendo `lugar no reconocido`. No se crean venues nuevos por heurística ni se igualan nombres parecidos (p. ej. el centro CondeDuque no es el auditorio canónico). Los eventos ya citados por URL o `externalId` se dejan igual: Phase 2.4 no re-clasifica ni borra `data/**`.

### Report por evento

El resumen humano de la CLI sigue siendo el agregado. `--report` añade un artifact JSON para inspeccionar cada evento observado procesable:

```bash
npm run ingest:source -- madrid-datos --dry-run --report ingestion/reports/madrid-datos.json
```

El fichero contiene `summary` (el mismo agregado de la CLI) y `events[]`. Cada fila incluye, cuando aplica: `sourceId`, `sourceUrl`, `externalId`, `title`, hidratación, descarte estructural, eligibility (valor, método, `ruleId`, evidencia), si se intentó IA, diagnósticos de transporte `ai` (modelo final, si hubo fallback, intentos) cuando el provider los expone, `formats` / `eras` / `kind` / `access` con método y `ruleId`, si es publicable, si se generó Candidate, y `existing` / `new` cuando esa identidad se puede determinar con seguridad contra el catálogo (URL o `externalId`). Si hay Candidate, `candidate` proyecta los hechos que se escribirían (`id`, `slug`, `status`, `venueId`, occurrences, performers, composers, works, eras, formats, kind, access) para inspeccionarlos antes de escribir; no altera el Candidate ni se envía al classifier. El `summary.ai` desglosa include/exclude/uncertain de IA, `ai-invalid-output`, `ai-rate-limited`, otros errores, requests HTTP, retries, fallbacks de modelo y conteos por modelo.

Es un diagnóstico. No cambia las decisiones de clasificación, no cambia qué se publica, no añade campos al `Event` canónico y no se escribe en `data/**`. En dry-run el catálogo no se modifica. `ingestion/reports/` está gitignorado: no hace falta versionar dumps de una ejecución.

Sin provider o credenciales utilizables el fallback de IA no se invoca; los `uncertain` quedan `uncertain` y `aiAttempted` es `false`.

### Providers de IA

`AiClassifier` es provider-agnóstico. La CLI crea un provider por ejecución. `ingest:sync` / `ingest:source` cargan `.local/ai.env` (gitignorado); el entorno del proceso gana. Plantilla: `.env.example`. No commits ni imprimas la clave. La IA sólo interpreta casos deterministas `uncertain`: no reabre `include` / `exclude`. `parseAiClassification()` sigue siendo la validación del JSON. No cambia la política editorial ni la puerta de publicación.

#### Pool Gemini / Gemma

Una API key autentica todos los modelos. Para cada llamada se elige el **primer modelo disponible**, respetando RPM, TPM, presupuesto diario y cooldown. No espera a un 429 para utilizar el siguiente. Una respuesta válida, incluido `uncertain`, termina la clasificación: no hay votación ni búsqueda de un `include` entre modelos.

Pool por defecto y presupuestos operativos (basados en las cuotas del proyecto a 2026-08-30, con margen):

| Orden | Modelo | RPM | TPM de entrada | Requests/día |
|---|---|---|---|---|
| 1 | `gemini-3.1-flash-lite` | 12 | 200.000 | 450 |
| 2 | `gemini-3.5-flash-lite` | 12 | 200.000 | 450 |
| 3 | `gemma-4-26b-a4b-it` | 24 | 12.800 | 12.960 |
| 4 | `gemma-4-31b-it` | 24 | 12.800 | 12.960 |

Gemma queda habilitado sin un benchmark previo. El código y CI prueban el contrato con respuestas simuladas; eso no certifica disponibilidad ni calidad de cada modelo en vivo. Se conservan JSON Schema, límites de salida y validación local. Los modelos con sólo 20 RPD no se añaden al pool por defecto. Un modelo personalizado explícito sin overrides recibe límites conservadores de 4 RPM, 12.800 TPM y 18 RPD.

Google limita por **proyecto y modelo**, no por clave. Las cifras pueden cambiar: consulta [AI Studio](https://aistudio.google.com/rate-limit) y la [documentación de cuotas](https://ai.google.dev/gemini-api/docs/rate-limits). Varias claves del mismo proyecto no añaden capacidad. Este código no crea proyectos, rota claves ni activa facturación.

Hasta cuatro clasificaciones avanzan en paralelo. La construcción de candidatos/IDs/slugs y el lote validate-then-write conservan el orden original, aunque las respuestas terminen en otro orden. Los diagnósticos son por llamada, sin compartir un “último modelo” mutable entre eventos.

#### Configuración

| Variable | Uso |
|---|---|
| `AI_PROVIDER` | `gemini` u `openai`. Sin valor: OpenAI si hay `OPENAI_API_KEY`; si no, Gemini si hay `GEMINI_API_KEY`. |
| `GEMINI_API_KEY` | Una credencial para todo el pool. Nunca se guarda en caché, cuota, pendientes ni reports. |
| `GEMINI_MODELS` | Lista ordenada por preferencia, separada por comas. Gana a `GEMINI_MODEL`. |
| `GEMINI_MODEL` | Compatibilidad: fija un solo modelo si no hay `GEMINI_MODELS`. Sin ambas variables se usa el pool de cuatro modelos. |
| `GEMINI_RPM` | Override global de RPM; por defecto se aplica la tabla por modelo. |
| `GEMINI_MODEL_RPM` / `GEMINI_MODEL_TPM` / `GEMINI_MODEL_RPD` | Overrides `modelo:entero`, separados por comas. Cero en cualquiera deshabilita el modelo. Los mapas mal formados producen error de configuración. |
| `GEMINI_CONCURRENCY` | Clasificaciones concurrentes, por defecto 4; rango 1–16. |
| `GEMINI_MAX_REQUESTS` | Presupuesto opcional HTTP por ejecución, incluidos retries. Sin valor no hay techo adicional al diario. Cero permite sólo caché. |
| `GEMINI_CACHE` | `on` por defecto. `off` desactiva lectura/escritura de caché para pruebas reales. **No** desactiva cuotas. |
| `GEMINI_STATE_DIR` | Por defecto `.local/ai/` relativo a la repo. Override relativo al directorio de trabajo, o absoluto. Usa la misma carpeta para ejecuciones del mismo proyecto en este equipo. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | Alternativa OpenAI existente (`gpt-4o-mini`, `https://api.openai.com/v1`). No participa en este pool ni recibe estos controles Gemini. |

**Migración:** si tu `.local/ai.env` conserva `GEMINI_MODEL=gemini-3.1-flash-lite`, seguirá fijando un solo modelo. Para activar el pool añade la línea `GEMINI_MODELS` de `.env.example`, sin sustituir tu API key. No hace falta configurar todos los límites: tienen defaults.

#### Caché, cuotas y pendientes

Todo queda bajo `GEMINI_STATE_DIR`, fuera de Git y de `data/**`:

- `cache/`: sólo respuestas de clasificación válidas. La clave incluye modelo, hechos enviados, texto/versión del prompt, esquema, parámetros, endpoint y revisión API. Una nueva run reutiliza respuestas, incluso de modelos secundarios; cambiar cualquiera de esos inputs provoca un miss. Los duplicados simultáneos comparten una llamada. Una respuesta `uncertain` válida también se cachea.
- `quota.json`: reservas antes de enviar HTTP, incluidos intentos fallidos; ventana de tokens/minuto, próximo envío, cooldown y consumo del día. Escrituras mediante fichero temporal + rename. Reiniciar no recupera cuota consumida. Un fichero corrupto produce error, nunca un reinicio silencioso a cero.
- `pending/`: hechos y petición de clasificaciones aplazadas por cuota, errores o salida inválida. No son decisiones editoriales ni candidatos publicables. Una ejecución posterior sobre esos mismos inputs los reintenta y borra el pendiente al obtener una respuesta válida. Si el evento ya no aparece en las fuentes, su snapshot permanece para recuperación manual; no se publica automáticamente desde esta carpeta.
- `run.lock`: impide dos ejecuciones simultáneas sobre ese estado. Se libera al terminar, fallar o recibir SIGINT/SIGTERM. Tras SIGKILL/cierre forzado puede quedar: comprueba el PID/host del fichero y retíralo sólo cuando la ejecución anterior ya no exista. No se roban locks automáticamente.

El día se calcula en `America/Los_Angeles`, incluido el cambio de horario. Un 429 **diario explícito** aparta el modelo hasta esa medianoche. Un 429 temporal respeta `Retry-After`/`retryDelay` completo; sin indicación usa backoff acotado con jitter. Mientras tanto puede usar otro modelo. Hay **tres intentos HTTP totales por evento**, no tres por modelo. Un 400/404 aparta ese modelo para el run; un 401/403 detiene nuevas llamadas con esa credencial. Timeouts/red/5xx tienen reintentos acotados. Los errores/salidas inválidas no se cachean como clasificación.

TPM usa una estimación conservadora del cuerpo enviado (incluye prompt y schema); la corrige con `usage.total_input_tokens` y ajusta futuras estimaciones por modelo. No se hacen llamadas extra para contar tokens. Es una aproximación, no una garantía de evitar cualquier 429. Una petición que exceda el TPM de un modelo se deriva a otro o queda pendiente; no se recorta evidencia para hacerla caber. Las esperas y peticiones se cancelan al vencer el presupuesto temporal, sin llamadas tardías en segundo plano.

El contador sólo conoce ejecuciones que comparten ese directorio. Otras herramientas, equipos o carpetas pueden consumir cuota del mismo proyecto; las respuestas de Google siguen siendo autoritativas. No hay coordinación distribuida ni consulta automática de cuota restante. Mantén el proyecto en Free Tier en AI Studio si necesitas coste cero: un presupuesto local de requests no convierte un proyecto de pago en gratuito.

`--dry-run` no escribe el catálogo, pero sí puede gastar cuota y guardar este estado local. `--report` incluye caché, pendientes, requests/retries, tokens de entrada medidos, consumo diario local y modelo/motivo de routing/intentos por evento. `aiAttempted` indica que se invocó el provider, incluso si resolvió desde caché; el número de HTTP reales aparece separado. `modelFallbacks` cuenta envíos a modelos distintos del primero, también por reparto normal.

#### Ejecuciones y benchmarks

```bash
# Ejecución normal con caché y pool; el report no publica datos.
npm run ingest:sync -- --dry-run --report ingestion/reports/pool.json

# Presupuesto por run: máximo 40 llamadas HTTP; el resto queda pendiente.
npm run ingest:sync -- --dry-run --ai-max-requests 40

# Prueba real fijando un modelo, sin caché ni fallback a otros modelos.
npm run ingest:sync -- --dry-run --ai-model gemma-4-31b-it --ai-no-cache --ai-max-requests 40 --report ingestion/reports/gemma.json
```

Las opciones `--ai-*` requieren Gemini configurado; ganan al entorno. `--ai-model` fija un solo modelo incluso cuando `.local/ai.env` define el pool. El límite de requests **no** selecciona una muestra editorial: para comparaciones reproducibles usa los mismos hechos/fixtures, prompt y parámetros. Los tests ordinarios usan fakes y relojes inyectados y no llaman a una API real. `--ai-no-cache` no altera la caché reutilizable ni desactiva los contadores persistentes.

### Candidatos JSON (legacy)

1. Un agente o una persona extrae un evento y lo escribe como candidato (`src/lib/schemas/candidate.ts`).
2. El fichero se deja en `ingestion/inbox/` (gitignored).
3. `npm run ingest:promote` valida, fusiona en memoria con `data/` y, si todo es correcto, escribe ficheros nuevos.

```bash
npm run ingest:promote -- ingestion/inbox/mi-evento.json
```

El script no sobrescribe un evento que ya exista. Si el candidato incluye un lugar, organizador, serie o fuente cuyo ID ya está en el catálogo, la entidad candidata debe coincidir campo a campo con la canónica. Cualquier diferencia es un conflicto: la promoción falla y no escribe ningún fichero.

Los duplicados de alta confianza (mismo lugar + fecha + hora + título normalizado) se rechazan. La misma URL de fuente + la misma fecha no bloquea: si aparece, es sólo un aviso. Los casos ambiguos quedan para revisión.

Al extraer, una misma entidad `Event` solo agrupa `occurrences` cuando comparten los atributos musicales y contextuales esenciales. Si cambian de forma sustancial el lugar, el programa, el reparto relevante o las condiciones, son eventos separados.

Directorios de trabajo (ignorados por Git):

- `ingestion/inbox/` — candidatos pendientes
- `ingestion/work/` — normalización en curso
- `ingestion/rejected/` — descartados, para inspección
- `ingestion/reports/` — dumps JSON de `--report` (diagnóstico; no son datos canónicos)

Formato mínimo de un candidato:

```json
{
  "schemaVersion": 1,
  "event": { "...": "mismo esquema que data/events" },
  "venue": { "...": "opcional, si el lugar es nuevo" },
  "organizers": [],
  "series": null,
  "sources": [],
  "notes": "opcional, no se publica"
}
```

Un agente de IA puede descubrir, extraer y clasificar. Nunca debe saltarse la validación ni escribir directo en `data/` de producción sin el mismo esquema que un cambio manual.

## Infraestructura legacy durante la migración

Mientras se implementa la v3, puede seguir existiendo esta infraestructura:

- `ingest:promote`
- `ingestion/inbox/`
- `ingestion/work/`
- `ingestion/rejected/`
- el esquema `Candidate` como fichero JSON en disco

Eso puede seguir existiendo durante la migración. No lo interpretes como arquitectura objetivo ni como requisito para nuevas piezas de ingestión.

La v3 prevé que, en el flujo automático normal, los candidatos puedan existir sólo en memoria; `ingestion/inbox/` queda como herramienta de imports manuales, debugging y casos excepcionales. Ver [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md).

## Arquitectura objetivo

La fuente de verdad para cualquier trabajo de evolución de la ingestión es [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md).

Principio rector de la v3: *el código obtiene y controla los hechos; la IA ayuda a interpretar, enriquecer, descubrir y reparar; Git valida y publica.*

El flujo normal previsto (harvesting con adapters, `RawEvent`, normalización, enrichment, reconciliación, PR y auto-merge, cadencia ~10 días, ventana de 120 días) está especificado allí. No se duplica en este documento.

Hoy **sí** están implementados (fase 1 + **fase 2 completa**: 2.1 + 2.2 + 2.3 + 2.4): adapters con interpretación estricta, `RawEvent` de hechos observados, hidratación de fichas (Auditorio Nacional y Teatro Real; Madrid Datos no la necesita), registry mínimo (referencia a Source canónica + seed), normalización común, proyección explícita a `ObservedFacts`, classifier determinista, fallback de IA con degradación segura, **puerta de publicación** (`include` → Candidate; `exclude`/`uncertain` → no publicar), report JSON opcional por evento (`--report`), lote validate-then-write atómico, contrato async-compatible de `extract`/`hydrate`, y CLI local. **No** están implementados discovery automático, reconciliación fuzzy, política de desapariciones, GitHub Actions de ingestión ni auto-merge (fase 3+). No los añadas salvo que una tarea pida explícitamente la fase correspondiente.

## CI y auto-merge (hoy vs objetivo)

La CI actual (`.github/workflows/ci.yml`) valida, testea, typecheckea y construye. **No** aprueba PRs ni fusiona sola.

El objetivo de la v3 es que una ejecución sana llegue a merge sin intervención humana ordinaria, con auto-merge sólo si los checks están verdes. Eso requiere configuración de GitHub que no vive en el código y **no** forma parte de la implementación actual. No añadas branch protection, required checks ni workflows de ingestión a menos que una tarea lo pida.

## Documentación histórica

No usar como especificación vigente, salvo que una tarea pida investigar decisiones anteriores:

- [`docs/archive/ingestion-v2-plan.md`](archive/ingestion-v2-plan.md) — plan de evolución v2
- [`docs/archive/ingestion-inspiration.md`](archive/ingestion-inspiration.md) — investigación de patrones externos
