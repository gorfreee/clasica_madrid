# Ingestión v3 — arquitectura objetivo

> Estado: **roadmap / arquitectura de evolución**. Las capacidades núcleo de la v3 ya están en producción. Este documento explica hacia dónde sigue el sistema y qué restricciones deben conservarse; **no** es el manual operativo.
>
> Qué hay implementado hoy: [`docs/ingestion.md`](ingestion.md). Política editorial: [`docs/classification-policy.md`](classification-policy.md). Histórico: [`docs/archive/`](archive/).
>
> La v3 no pretende construir una plataforma de datos genérica. Pretende mantener una agenda de descubrimiento de música clásica con buena cobertura, trazabilidad y calidad, minimizando infraestructura, coste y mantenimiento.

---

## 1. Decisiones de producto y operación

- la ingestión automática ordinaria se ejecuta de forma periódica (aproximadamente cada diez días; el schedule concreto está en el workflow) y cubre la temporada hasta el **31 de julio más cercano**; el CLI y el dispatch manual sin fechas usan una ventana más corta (hoy → +120 días);
- el objetivo operativo sigue siendo **0 % de intervención humana** en el flujo normal;
- `eras` y `formats` deben intentarse siempre, pero una clasificación ausente o incierta **no debe bloquear por sí sola** la publicación de un evento fiable;
- el pipeline fundamental debe poder funcionar aunque temporalmente no haya ningún agente de IA disponible;
- no se introducen por defecto bases de datos, colas, orquestadores, plataformas ETL ni servicios de pago;
- Git, JSON, TypeScript, GitHub Actions y las validaciones deterministas siguen siendo la base mientras sean suficientes.

El cadence exacto, los inputs del workflow y las reglas de auto-merge viven en [`docs/ingestion.md`](ingestion.md) y en `.github/workflows/ingestion.yml`. No los dupliques aquí.

La meta no es automatizar cualquier caso imaginable. La meta es que el catálogo se mantenga solo en condiciones normales y que los casos difíciles degraden sin comprometer el resto de la ejecución.

---

## 2. Principio rector

> **El código obtiene y controla los hechos; la IA ayuda a interpretar, enriquecer, descubrir y reparar; Git valida y publica.**

Esto evita dos extremos:

1. pedir a un agente generalista que reconstruya periódicamente todo el catálogo desde Internet;
2. intentar resolver mediante scraping puramente determinista tareas que realmente requieren interpretación musical o semántica.

---

## 3. Qué problema estamos resolviendo

Clásica Madrid es principalmente una plataforma de descubrimiento. El catálogo debe permitir responder: qué conciertos hay, cuándo y dónde, quién interpreta, qué repertorio, qué tipo de concierto, a qué épocas pertenece, si es gratuito o de pago, y dónde está la fuente original.

La web no necesita sustituir a la fuente oficial. Debemos maximizar cobertura y fiabilidad de los datos útiles para descubrir eventos, no construir una copia perfecta de cada página fuente.

---

## 4. Harvesting y discovery

### Harvesting

Sabemos dónde buscar (teatros, auditorios, ciclos, fuentes ya en el registry). La pregunta es: ¿qué eventos publica ahora esta fuente para nuestra ventana temporal? Se resuelve principalmente con código y adapters.

### Discovery

No sabemos todavía dónde buscar (iglesias, asociaciones, recitales poco visibles, nuevas fuentes). La pregunta es: ¿qué eventos relevantes estamos perdiendo? Es más adecuado para agentes con búsqueda e interpretación.

### Ciclo de aprendizaje

Cada descubrimiento debe intentar reducir trabajo futuro: si proviene de una fuente recurrente útil, evaluar un adapter; si no, procesarlo como evento puntual. La cobertura determinista debería crecer; la búsqueda abierta sigue existiendo para la larga cola. **La promoción automática a adapters todavía no existe.**

---

## 5. Estado por capacidad

| Capacidad | Estado | Dónde está el detalle |
|---|---|---|
| Harvesting y adapters | En producción | [`docs/ingestion.md`](ingestion.md), `src/ingestion/`, registry |
| Enrichment / classification | En producción | [`docs/ingestion.md`](ingestion.md), [`docs/classification-policy.md`](classification-policy.md) |
| Reconciliation determinista | En producción | [`docs/ingestion.md`](ingestion.md) |
| Automatización y publicación (Actions, PR, CI, auto-merge condicionado) | En producción | [`docs/ingestion.md`](ingestion.md), `.github/workflows/` |
| Discovery v1 (contexto / batch estructurado) | En producción | [`docs/ingestion.md`](ingestion.md) |
| Observabilidad de ejecuciones | En producción | [`docs/ingestion.md`](ingestion.md) |
| Búsqueda web automática de discovery | Pendiente | este documento |
| Scheduling propio de discovery | Pendiente | este documento |
| Aprendizaje / promoción automática de fuentes | Pendiente | este documento |
| Reconciliación fuzzy o con IA residual | Pendiente, sólo si se decide | este documento |

No implementes una capacidad pendiente salvo que una tarea la pida.

---

## 6. Arquitectura

El flujo objetivo —hoy el flujo real de harvesting— es:

```text
                     ┌────────────────────────┐
                     │    SOURCE REGISTRY     │
                     └───────────┬────────────┘
                                 ▼
                     ┌────────────────────────┐
                     │    SOURCE ADAPTERS     │
                     └───────────┬────────────┘
                                 ▼
                            RawEvent[]
                                 ▼
                           NORMALIZE
                                 ▼
                     ENRICH (reglas + knowledge + IA)
                                 ▼
                            Candidate[]
                                 ▼
                       MATCH / DEDUP / DIFF
                                 ▼
                       VALIDATE / APPLY BATCH
                                 ▼
                              data/**
                                 ▼
                              PR / CI / merge


             DISCOVERY (complementario)
                    agente
                       ▼
            nuevos eventos / fuentes
                       ▼
                    RawEvent[]  →  mismo pipeline
```

Harvesting y discovery convergen en `RawEvent` / `PipelineSource` antes de normalize. Discovery v1 exporta un contexto compacto para un agente externo e importa un batch de hechos observados; no extrae la web ni evalúa desapariciones.

Mientras el volumen lo permita, la implementación es TypeScript en esta repo. Copiar patrones (adapter por fuente, modelo intermedio, strict interpretation, aislamiento de fallos, IA después de reglas baratas), no plataformas completas. La estructura de carpetas es la del código, no una especulación de este documento.

---

## 7. Contratos que deben conservarse

Estos principios ya gobiernan el código. Cualquier evolución futura debe respetarlos. El detalle ejecutable no se duplica aquí.

**Registry y adapters.** El registry describe cómo encontrar y extraer eventos, no la procedencia editorial de `data/sources/`. Cada adapter convierte una fuente en `RawEvent[]` de información **observada**. No decide cómo publicar, no escribe `data/**`, no infiere `kind` ni elegibilidad editorial. Preferir, cuando sea razonable: JSON público → JSON-LD → ICS/feeds → HTML estructurado → adapter custom → IA si la estructura no admite una solución robusta.

**Strict interpretation.** Si el parser ya no entiende una sección, fallo visible para esa fuente; el resto continúa. Una extracción vacía es sospechosa cuando el documento *parece* contener calendario. Un calendario genuinamente vacío no es un error. `extract` parsea el listing; la hidratación de fichas es posterior.

**Enrichment.** Extraer no es clasificar. Eligibility tiene prioridad: un `exclude` no debe gastar clasificación posterior. Un `uncertain` no se publica automáticamente. Preferencia: hecho explícito → regla determinista segura → knowledge persistido → IA → fallback seguro. Estar publicado en un venue habitualmente clásico **no implica** que el evento pertenezca al alcance.

Tri-state interno (no es un campo del schema `Event`): `include` / `exclude` / `uncertain`. `kind` es el contexto del evento (`established` / `alternative`), no un ranking de calidad ni una propiedad de la source.

**IA.** Interpreta hechos ya extraídos; no navega la web en el enrichment. No inventa performers, obras, fechas, venues ni URLs. `uncertain` es una salida válida. Un evento bien identificado no debe quedar fuera **solo** porque `eras`/`formats` no se hayan resuelto. CI no llama a un LLM. La ausencia de IA no debe corromper ni bloquear el catálogo.

**Candidate y lote.** En el flujo automático los candidatos existen **en memoria**. `ingestion/inbox/` sirve para imports manuales, debugging y casos excepcionales. Cada ejecución se procesa como conjunto y se escribe de forma coherente. Un fallo no debe dejar media ejecución aplicada. La v3 evita cursores incrementales hasta que haya evidencia de que hacen falta.

**Cambios y desapariciones.** Un evento futuro que desaparece de una fuente **no** se borra automáticamente. Un evento histórico nunca se elimina porque deje de aparecer en la fuente actual. Deduplicación escalonada: identidad estable primero; heurística/fuzzy e IA sólo sobre candidatos ya plausibles, y **eso último aún no está implementado**.

**Aislamiento de fallos.** Una fuente rota no debe tirar toda la ejecución. Fallo local: aislar. Fallo global (schema inválido, referencias corruptas, colisión de identidad irresoluble): no publicar el lote afectado.

La política editorial vigente es [`docs/classification-policy.md`](classification-policy.md). El golden set está en `tests/fixtures/ingestion/golden/`.

---

## 8. Automatización y publicación

GitHub Actions es el orquestador actual: scheduling, runners, logs, secrets, PRs y CI. No se introduce un orquestador externo mientras esto baste. Debe mantenerse ejecución manual (`workflow_dispatch` o CLI).

El flujo ordinario ya completa:

```text
fetch → extract → normalize → enrich → reconcile → validate → write → PR → CI → auto-merge
```

Cero intervención no significa saltarse controles. La confianza viene de adapters versionados, schemas, tests, deduplicación, límites sobre qué paths toca la automatización, CI y auto-merge **sólo** cuando health y configuración lo permiten.

Cuando un caso no pueda resolverse, el comportamiento preferido es **degradar o excluir ese dato**, no pedir revisión humana como paso ordinario del pipeline. Se registra el fallo, se conserva el catálogo anterior, se continúa con el resto.

No añadas branch protection ni required checks. El detalle de health, kill switch, permisos y recovery está en [`docs/ingestion.md`](ingestion.md).

---

## 9. Discovery: qué hay y qué falta

El harvesting de fuentes conocidas nunca cubrirá la larga cola. Discovery v1 ya permite que un agente externo reciba un contexto compacto y devuelva un batch estructurado al pipeline común. El código de esta repo no busca en la web ni programa esas ejecuciones.

Siguen pendientes, y no deben añadirse de pasada:

- búsqueda web automática dentro del repo o de Actions;
- scheduling propio de discovery;
- un ledger o aprendizaje que promocione fuentes recurrentes a adapters;
- fuzzy reconciliation para encajar descubrimientos ambiguos con el catálogo.

Tarea conceptual de un agente de discovery: eventos de los próximos 120 días que probablemente no estén cubiertos; devolver hechos estructurados y señalar fuentes recurrentes nuevas para evaluación humana o una tarea posterior de adapter.

---

## 10. Observabilidad, tests e idempotencia

Cada ejecución debe seguir produciendo un resumen legible y, cuando sea útil, un artifact estructurado. Invertir más en tests que en infraestructura: fixtures por adapter, Classification Policy contra el golden set, reconciliación (nuevo, sin cambios, modificado, desaparecido, duplicado, fallo de una source). CI no llama a un LLM.

Propiedad deseable de `ingest:sync`: ejecutar dos veces consecutivas contra las mismas fuentes debería producir cero cambios en la segunda. Una reverificación cuyo único delta son timestamps de verificación tampoco debe escribir `data/**`, salvo la política de refresco ya documentada en [`docs/ingestion.md`](ingestion.md).

---

## 11. Qué NO hacer

Salvo necesidad demostrable: PostgreSQL/Supabase, Redis, Kafka, colas, Airbyte, Meltano, Dagster, Prefect, Temporal, scraping comercial, vector DBs para dedup, un microservicio por fuente, Docker obligatorio por adapter, infra multi-agent compleja, revisión humana obligatoria, cursores incrementales sofisticados, data lake de snapshots, schemas dinámicos generados automáticamente.

No reconstruyas la automatización de publicación que ya existe. No trates `docs/archive/` como especificación de la ingestión actual.

---

## 12. Criterios de éxito que siguen vigentes

Varios ya se cumplen en producción; siguen siendo la vara para cualquier evolución:

1. una ejecución se lanza con un único comando o un workflow;
2. GitHub Actions la ejecuta de forma periódica;
3. mantiene automáticamente la temporada hasta el próximo 31 de julio;
4. una fuente rota no bloquea las sanas;
5. una segunda ejecución sin cambios no modifica la repo;
6. eventos nuevos y actualizados se detectan automáticamente;
7. `eras` y `formats` se completan en la gran mayoría;
8. una clasificación irresoluble no bloquea un evento esencialmente fiable;
9. la ausencia temporal de IA no inutiliza harvesting;
10. los cambios válidos llegan hasta merge sin intervención humana;
11. todo evento publicado conserva trazabilidad hacia su fuente;
12. el pipeline sigue siendo entendible por una sola persona leyendo la repo.

El hueco principal respecto a esta lista es la **cobertura de la larga cola** (discovery abierto de verdad), no la orquestación de harvesting.

---

## 13. Principio final

La ingestión no necesita convertirse en una plataforma de ingeniería de datos. Necesita ser un pequeño sistema fiable de sincronización y descubrimiento.

Cuando haya que elegir entre una solución elegante pero compleja y una solución sencilla que mantenga correctamente el catálogo, la v3 debe preferir la segunda.
