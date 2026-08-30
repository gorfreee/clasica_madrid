# Ingestión v3 — arquitectura pragmática y automatizada

> Estado: **diseño objetivo vigente** para evolucionar la ingestión. Las fases 1–3 (harvesting, clasificación, puerta de publicación y reconciliation) ya viven en `src/ingestion/` y se operan con `npm run ingest:sync`. Este documento define hacia dónde va el resto; no es un diario de lo ya implementado.
>
> Qué hay hoy: [`docs/ingestion.md`](ingestion.md). Política editorial: [`docs/classification-policy.md`](classification-policy.md). Histórico: [`docs/archive/`](archive/).
>
> La v3 no pretende construir una plataforma de datos genérica. Pretende mantener una agenda de descubrimiento de música clásica con buena cobertura, trazabilidad y calidad, minimizando infraestructura, coste y mantenimiento.

---

## 1. Decisiones de producto y operación

- la ingestión automática ordinaria se ejecutará aproximadamente **cada 10 días**;
- en cada ejecución se trabajará sobre una ventana móvil de los **próximos 120 días**;
- el objetivo operativo es **0 % de intervención humana** en el flujo normal;
- `eras` y `formats` deben intentarse siempre, pero una clasificación ausente o incierta **no debe bloquear por sí sola** la publicación de un evento fiable;
- el pipeline fundamental debe poder funcionar aunque temporalmente no haya ningún agente de IA disponible;
- no se introducen por defecto bases de datos, colas, orquestadores, plataformas ETL ni servicios externos de pago;
- Git, JSON, TypeScript, GitHub Actions y las validaciones actuales siguen siendo la base mientras sean suficientes.

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

Cada descubrimiento debe intentar reducir trabajo futuro: si proviene de una fuente recurrente útil, evaluar un adapter; si no, procesarlo como evento puntual. La cobertura determinista debería crecer; la búsqueda abierta sigue existiendo para la larga cola.

---

## 5. Arquitectura objetivo

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

Harvesting y discovery convergen pronto en el mismo contrato intermedio.

Mientras el volumen lo permita, la implementación es TypeScript en esta repo. Copiar patrones (adapter por fuente, modelo intermedio, strict interpretation, aislamiento de fallos, IA después de reglas baratas), no plataformas completas. La estructura de carpetas es la del código, no una especulación de este documento.

---

## 6. Registry, adapters y hechos

El registry describe **cómo encontrar y extraer** eventos, no la procedencia editorial de `data/sources/`. Debe empezar pequeño. `Event.kind` no es un atributo de la source.

Cada adapter convierte una fuente en `RawEvent[]` de información **observada**. No decide cómo publicar, no escribe `data/**`, no infiere `kind` ni elegibilidad editorial.

Preferir, cuando sea razonable: JSON público → JSON-LD → ICS/feeds → HTML estructurado → adapter custom → IA si la estructura no admite una solución robusta.

**Strict interpretation:** si el parser ya no entiende una sección, fallo visible para esa fuente, el resto continúa. Una extracción vacía es sospechosa cuando el documento *parece* contener calendario. Un calendario genuinamente vacío no es un error.

`extract` parsea el listing. La hidratación de fichas es una etapa posterior. Un fallo de listing es de fuente; un fallo de ficha es local al evento.

`RawEvent` es el contrato intermedio entre extracción y dominio. La forma exacta vive en el código. Lo importante: separar hechos extraídos, interpretaciones derivadas y entidades canónicas.

Tras extraer, una capa común normaliza textos, fechas, URLs, venues conocidos y aliases. La IA puede ayudar en un caso ambiguo la primera vez; una decisión estable debería convertirse en conocimiento reutilizable.

---

## 7. Enrichment

La v3 separa extracción y clasificación. Un extractor puede conocer orquesta, obras y compositores sin poder concluir `formats` o `eras`.

```text
hechos observados
      ↓
eligibility
      ↓
formats / eras / kind / access
      ↓
Candidate
```

Eligibility tiene prioridad: un `exclude` no debe gastar clasificación posterior. Un `uncertain` no se publica automáticamente.

Preferencia:

```text
hecho explícito → regla determinista segura → knowledge persistido → IA → fallback seguro
```

Estar publicado en un venue o source habitualmente clásicos **no implica** que el evento pertenezca al alcance. La puerta de elegibilidad es del enrichment, no del harvesting.

Tri-state interno (no es un campo del schema `Event`):

```text
include   → puede continuar hacia Candidate
exclude   → se descarta
uncertain → no se publica automáticamente
```

La política editorial vigente es [`docs/classification-policy.md`](classification-policy.md). El golden set está en `tests/fixtures/ingestion/golden/`. No se duplican aquí taxonomías ni reglas.

`kind` es contexto del evento (`established` / `alternative`), no ranking de calidad ni propiedad de la source. Una sala «clásica» puede publicar eventos que no son `established`.

---

## 8. Uso de IA

La IA interpreta hechos ya extraídos; no navega la web en el flujo de enrichment. Recibe contexto acotado (título, descripción, intérpretes, compositores, obras), las taxonomías, la Classification Policy y un schema de salida. No inventa performers, obras, fechas, venues ni URLs. `uncertain` es una salida válida.

`confidence` y `evidence` pueden ser metadata interna; no tienen que publicarse.

Un evento bien identificado, fechado, localizado y respaldado por una fuente fiable no debe quedar fuera de la agenda **solo** porque `eras`/`formats` no se hayan resuelto. Campos vacíos generan señal; el evento puede publicarse si supera las validaciones esenciales.

El pipeline debe funcionar sin un proveedor concreto. Encapsular llamadas detrás de interfaces pequeñas: ejecutar sin IA, cambiar de proveedor, testear con fakes. CI no llama a un LLM.

Si la IA no está disponible: harvesting continúa, reglas y knowledge siguen, los campos no resueltos quedan para una ejecución posterior. La ausencia de IA no debe corromper ni bloquear el catálogo.

Los agentes (Cursor u otros) son útiles para discovery, fuentes difíciles, excepciones, nuevos adapters y tests. No son una dependencia crítica del pipeline esencial.

---

## 9. Candidate, batch y ventana

`Candidate` es la frontera entre datos extraídos/enriquecidos y datos canónicos. En el flujo automático normal los candidatos existen **en memoria**:

```text
RawEvent[] → Candidate[] → validate batch → apply batch
```

`ingestion/inbox/` sirve para imports manuales, debugging y casos excepcionales. No es una cola persistente obligatoria para cada evento rutinario.

Cuando un agente haga discovery abierto, no debería editar cientos de JSON canónicos uno a uno. Debe entregar un batch estructurado (o invocación de CLI); el código se concentra en IDs, matching, schemas, escritura y validación.

Cada ejecución se procesa como conjunto: cargar catálogo, extraer fuentes sanas, normalizar, enriquecer, resolver entidades, detectar duplicados, comparar, validar en memoria, escribir de forma coherente. Un fallo no debe dejar media ejecución aplicada.

La v3 evita inicialmente cursores o estado incremental. Cada ejecución ordinaria vuelve a revisar la ventana móvil de 120 días (hoy en Europe/Madrid → +120). El CLI admite un rango manual `--from`/`--to` sin tope de 120 días. La optimización incremental sólo cuando haya evidencia de que hace falta.

---

## 10. Cambios, desapariciones y deduplicación

La ingestión no es sólo inserción. Un evento publicado puede cambiar fecha, hora, lugar, programa, estado, URL, acceso o clasificación. Cada ejecución debe reconciliar lo observado con el catálogo actual.

Si un evento futuro desaparece de una fuente, **no** se borra automáticamente. Puede ser cancelación, reorganización, URL cambiada, error temporal o fallo del adapter. Un evento histórico nunca se elimina porque deje de aparecer en la fuente actual.

Deduplicación escalonada: `externalId` estable → URL de origen → IDs/aliases conocidos → coincidencias fuertes de fecha/hora/lugar/título → nombres normalizados → heurística/fuzzy sobre candidatos plausibles → IA para ambigüedad residual. La IA no compara cada evento contra todo el catálogo. Cuando una decisión ambigua se repita, convertirla en regla o alias.

---

## 11. Aislamiento de fallos

Una fuente rota no debe tirar toda la ejecución. Las fuentes sanas pueden seguir produciendo cambios. Los resultados dudosos de una fuente problemática no se publican.

**Fallo local** (timeout, HTML inesperado, parser roto, extracción vacía sospechosa): aislar.

**Fallo global** (schema inválido, referencias corruptas, colisión de identidad irresoluble): no publicar el lote afectado.

---

## 12. Automatización y publicación

La ejecución ordinaria se programa en GitHub Actions ~cada diez días (p. ej. días 1, 11 y 21). GitHub Actions es orquestador suficiente: scheduling, runners, logs, secrets, PRs, CI. No se introduce un orquestador externo mientras esto baste. Debe mantenerse ejecución manual (`workflow_dispatch` o CLI).

El objetivo es que una ejecución sana complete sola:

```text
fetch → extract → normalize → enrich → reconcile → validate → write → PR → CI → auto-merge
```

Cero intervención no significa saltarse controles. La confianza viene de adapters versionados, schemas, tests, deduplicación, límites sobre qué paths toca la automatización, CI y auto-merge **sólo** con checks verdes.

Cuando un caso no pueda resolverse, el comportamiento preferido es **degradar o excluir ese dato**, no pedir revisión humana como paso ordinario del pipeline. Se registra el fallo, se conserva el catálogo anterior, se continúa con el resto.

Esto **no** está implementado todavía: la CI actual no aprueba ni fusiona PRs. No añadas branch protection, required checks ni workflows de ingestión a menos que una tarea lo pida.

---

## 13. Discovery abierto

El harvesting de fuentes conocidas nunca cubrirá la larga cola. Periódicamente, agentes pueden buscar iglesias, conservatorios, centros culturales, asociaciones, festivales pequeños, agendas secundarias y webs de intérpretes, con contexto del catálogo y de las fuentes ya conocidas para concentrarse en huecos.

Tarea conceptual: eventos de los próximos 120 días que probablemente no estén cubiertos; devolver hechos estructurados y detectar nuevas fuentes recurrentes.

---

## 14. Observabilidad, tests e idempotencia

Cada ejecución debería producir un resumen legible y, cuando sea útil, un artifact estructurado: fuentes intentadas/ok/fallidas, raw events, nuevos/actualizados/sin cambios/posiblemente desaparecidos, duplicados, enriquecidos por reglas vs IA, `eras`/`formats` vacíos, fallos de validación.

Invertir más en tests que en infraestructura: fixtures por adapter (incluido fallo visible ante estructura inesperada), normalización (aliases, IDs, fechas), Classification Policy contra el golden set, reconciliación (nuevo, sin cambios, modificado, desaparecido, duplicado, fallo de una source). CI no llama a un LLM. La IA no es la única definición ejecutable de la política.

Propiedad deseable de `ingest:sync`: ejecutar dos veces consecutivas contra las mismas fuentes debería producir cero cambios en la segunda. Una reverificación cuyo único delta son timestamps de verificación (`lastVerifiedAt` / `citation.checkedAt`) tampoco debe escribir `data/**`; esa frescura vive en el report. Eso simplifica retries, debugging y confianza en la automatización.

---

## 15. CLI y flujo normal

Las operaciones deben ser reproducibles sin manipular archivos a mano. Hoy existen `ingest:sync` y `ingest:source`. Más adelante pueden añadirse process de imports, validate o discover si hay necesidad concreta. No hace falta una familia de comandos especulativa.

Flujo completo previsto:

```text
1. load source registry + canonical catalog
2. fetch / extract RawEvent[] por fuente
3. isolate source failures
4. hydrate detail pages cuando haga falta
5. normalize
6. eligibility + enrich (reglas, knowledge, IA con fallback)
7. reconcile + deduplicate
8. compare with current 120-day catalog
9. validate in memory
10. write coherent changes
11. PR → CI → auto-merge if green
12. emit run summary
```

El flujo hasta el paso 12 está implementado. El dominio expone ventana explícita, selección de sources, diffs materiales, `health` y `autoMergeEligible`; `.github/workflows/ingestion.yml` añade ejecución scheduled/manual, state persistente, report/summary, PR única, CI y squash auto-merge conservador.

---

## 16. Qué NO hacer en v3

Salvo necesidad demostrable: PostgreSQL/Supabase, Redis, Kafka, colas, Airbyte, Meltano, Dagster, Prefect, Temporal, scraping comercial, vector DBs para dedup, un microservicio por fuente, Docker obligatorio por adapter, infra multi-agent compleja, revisión humana obligatoria, cursores incrementales sofisticados, data lake de snapshots, schemas dinámicos generados automáticamente.

---

## 17. Fases

**Hechas (1, 2, 3 y 4):** contratos, adapters, hidratación, classifier determinista, fallback de IA, puerta de publicación, matching determinista, merge conservador, updates, desapariciones sólo como diagnóstico, escritura atómica, automatización scheduled/manual, PR de datos, observabilidad y auto-merge condicionado. El detalle está en el código y en [`docs/ingestion.md`](ingestion.md).

**Fase 3 — reconciliation (hecha):** matching contra catálogo (`externalId` → URL → alias → coincidencia fuerte única), aliases tipados, deduplicación batch, updates no destructivos, `possiblyMissing` diagnóstico, tests de idempotencia. Queda fuera de esta fase el fuzzy/IA matching y cualquier política que borre o cancele por ausencia.

**Fase 4 — automatización GitHub (hecha):** workflow serializado los días 1/11/21 a las 09:17 de Europe/Madrid y dispatch manual seguro; cache persistente de Gemini sin `run.lock`; report y Job Summary siempre que el pipeline llega a generarlos; no-op sin PR; límite estricto `data/**`; una única PR de ingestión; draft para `review`; y squash auto-merge de `clean`/`degraded` sólo con kill switch, opt-in manual cuando aplica y CI normal verde.

**Fase 5 — ampliar fuentes conocidas:** adapters progresivos; cada fuente recurrente descubierta se evalúa para el registry.

**Fase 6 — discovery con agentes:** input/contexto del agente, batch estructurado al pipeline común, detección de nuevas sources.

No implementar una fase posterior salvo que una tarea lo pida.

---

## 18. Criterios de éxito

1. una ejecución se lanza con un único comando;
2. GitHub Actions la ejecuta ~cada diez días;
3. mantiene automáticamente los próximos 120 días;
4. una fuente rota no bloquea las sanas;
5. una segunda ejecución sin cambios no modifica la repo;
6. eventos nuevos y actualizados se detectan automáticamente;
7. `eras` y `formats` se completan en la gran mayoría;
8. una clasificación irresoluble no bloquea un evento esencialmente fiable;
9. la ausencia temporal de IA no inutiliza harvesting;
10. los cambios válidos llegan hasta merge sin intervención humana;
11. todo evento publicado conserva trazabilidad hacia su fuente;
12. el pipeline sigue siendo entendible por una sola persona leyendo la repo.

---

## 19. Principio final

La ingestión no necesita convertirse en una plataforma de ingeniería de datos. Necesita ser un pequeño sistema fiable de sincronización y descubrimiento.

Cuando haya que elegir entre una solución elegante pero compleja y una solución sencilla que mantenga correctamente el catálogo, la v3 debe preferir la segunda.
