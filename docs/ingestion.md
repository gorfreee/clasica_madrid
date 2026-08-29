# Ingestión de eventos

Este documento es la **puerta de entrada operativa** a la ingestión: qué hay implementado hoy y hacia dónde ir.

No es la especificación de arquitectura objetivo.

| Qué necesitas | Dónde |
|---|---|
| Diseño objetivo vigente (fuente de verdad para evolucionar la ingestión) | [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md) |
| Estado operativo actual (este documento) | `docs/ingestion.md` |
| Classification Policy v1 y criterios de Phase 2 | [`docs/classification-policy.md`](classification-policy.md) |
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
4. Hidrata fichas de detalle cuando el adapter implementa `hydrate` (Auditorio Nacional y Teatro Real). Un fallo de ficha (404, 403, HTML inesperado) es local al evento: se conservan los hechos del listing. Madrid Datos no hidrata: el JSON-LD ya trae los hechos disponibles.
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

`--dry-run` valida y resume sin escribir. `--data-dir` apunta a otro árbol (por defecto `data/` o `DATA_DIR`). `--report <ruta>` escribe un JSON diagnóstico de la ejecución; no cambia la clasificación ni qué se publica. La CLI rechaza flags desconocidas, `--data-dir` o `--report` sin ruta, fuentes inexistentes y combinaciones incorrectas de argumentos.

Un adapter que reconoce la estructura general pero no consigue interpretar ningún evento (extracción vacía sospechosa) falla de forma visible; esa fuente se aísla y las demás continúan. Un calendario genuinamente vacío no es un error.

No hay GitHub Actions de ingestión ni auto-merge. Un evento nuevo se publica sólo si la clasificación final es `include` y los datos estructurales (fecha en ventana, lugar reconocible) son válidos. `exclude` no se publica. `uncertain` no se publica (tampoco como include de baja confianza). Sin `OPENAI_API_KEY`, con timeout o respuesta inválida, el fallback de IA degrada a `uncertain` y el resto del lote continúa. CI no llama a un LLM: `runIngest` recibe un `AiClassifier` inyectado por la CLI (`createAiClassifierFromEnv()`). `eras` y `formats` vacíos no bloquean un `include`. `kind` sale del classifier, no de la source. Performers, composers y works se copian cuando la ficha los declara; el rol canónico sólo se asigna si `roleText` es inequívoco. Sólo se publica si el lugar se reconoce de forma inequívoca (catálogo o alias conocidos). Los eventos ya citados por URL o `externalId` se dejan igual: Phase 2.4 no re-clasifica ni borra `data/**`.

### Report por evento

El resumen humano de la CLI sigue siendo el agregado. `--report` añade un artifact JSON para inspeccionar cada evento observado procesable:

```bash
npm run ingest:source -- madrid-datos --dry-run --report ingestion/reports/madrid-datos.json
```

El fichero contiene `summary` (el mismo agregado de la CLI) y `events[]`. Cada fila incluye, cuando aplica: `sourceId`, `sourceUrl`, `externalId`, `title`, hidratación, descarte estructural, eligibility (valor, método, `ruleId`, evidencia), si se intentó IA, `formats` / `eras` / `kind` / `access` con método y `ruleId`, si es publicable, si se generó Candidate, y `existing` / `new` cuando esa identidad se puede determinar con seguridad contra el catálogo (URL o `externalId`).

Es un diagnóstico. No cambia las decisiones de clasificación, no cambia qué se publica, no añade campos al `Event` canónico y no se escribe en `data/**`. En dry-run el catálogo no se modifica. `ingestion/reports/` está gitignorado: no hace falta versionar dumps de una ejecución.

Sin `OPENAI_API_KEY` el fallback de IA no se invoca; los `uncertain` quedan `uncertain` y `aiAttempted` es `false`.

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
