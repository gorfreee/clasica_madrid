# Ingestión v3 — arquitectura pragmática y automatizada

> Estado: **diseño objetivo vigente y fuente de verdad autoritativa** para la evolución de la ingestión. Este documento define la dirección recomendada para evolucionar la ingestión de Clásica Madrid a una v3 simple, mantenible, automatizada y preparada para usar IA de forma pragmática.
>
> **Phase 1 ✅ · Phase 2.1 ✅ · Phase 2.2 ✅ · Phase 2.3 ✅ · Phase 2.4 ✅ — PHASE 2 COMPLETE.** El harvesting, la clasificación (determinista + fallback de IA) y la puerta de publicación viven en `src/ingestion/` y se operan con `npm run ingest:sync`. Las fases 3–6 siguen siendo diseño objetivo.
>
> [`docs/classification-policy.md`](classification-policy.md) es la política editorial de enrichment. [`docs/ingestion.md`](ingestion.md) es la puerta de entrada operativa (qué hay implementado hoy). Los documentos en [`docs/archive/`](archive/) son investigación y planes históricos: no son requisitos vigentes.
>
> Toma como base la investigación histórica en [`docs/archive/ingestion-v2-plan.md`](archive/ingestion-v2-plan.md) y [`docs/archive/ingestion-inspiration.md`](archive/ingestion-inspiration.md), el modelo de datos actual y las lecciones de las primeras cargas reales.
>
> La v3 no pretende construir una plataforma de datos genérica. Pretende mantener una agenda de descubrimiento de música clásica con buena cobertura, trazabilidad y calidad, minimizando infraestructura, coste y mantenimiento.

---

## 1. Decisiones de producto y operación

La v3 parte de estas decisiones explícitas:

- la ingestión automática ordinaria se ejecutará aproximadamente **cada 10 días**;
- en cada ejecución se trabajará sobre una ventana móvil de los **próximos 120 días**;
- el objetivo operativo es **0 % de intervención humana** en el flujo normal;
- `eras` y `formats` deben intentar estar siempre informados, pero una clasificación ausente o incierta **no debe bloquear por sí sola la publicación** de un evento fiable;
- Codex y Cursor deben utilizarse de forma habitual cuando estén disponibles y aporten valor;
- aun así, el pipeline fundamental debe poder funcionar aunque temporalmente no haya ningún agente de IA disponible;
- no se introducen por defecto bases de datos, colas, orquestadores, plataformas ETL ni servicios externos de pago;
- Git, JSON, TypeScript, GitHub Actions y las validaciones actuales siguen siendo la base del sistema mientras sean suficientes.

La meta no es automatizar cualquier caso imaginable a cualquier precio. La meta es que el catálogo se mantenga solo en condiciones normales y que los casos difíciles degraden de forma segura sin comprometer el resto de la ejecución.

---

## 2. Principio rector

La v3 se diseña alrededor de una idea simple:

> **El código obtiene y controla los hechos; la IA ayuda a interpretar, enriquecer, descubrir y reparar; Git valida y publica.**

Esto evita dos extremos:

1. pedir a un agente generalista que reconstruya periódicamente todo el catálogo desde Internet;
2. intentar resolver mediante scraping puramente determinista tareas que realmente requieren interpretación musical o semántica.

La arquitectura debe utilizar cada herramienta donde aporta más valor.

---

## 3. Qué problema estamos resolviendo

Clásica Madrid es principalmente una plataforma de descubrimiento.

El catálogo debe permitir al usuario responder preguntas como:

- qué conciertos hay;
- cuándo y dónde son;
- quién interpreta;
- qué compositores o repertorios aparecen;
- qué tipo de concierto es;
- a qué épocas musicales pertenece;
- si es gratuito o de pago;
- dónde consultar la fuente original.

La web no necesita sustituir a la fuente oficial para ofrecer todos los detalles comerciales, biográficos o logísticos. La fuente original sigue siendo el lugar donde el usuario puede ampliar información, contrastar cambios y comprar entradas.

Esto tiene una consecuencia importante para la ingestión:

> debemos maximizar cobertura y fiabilidad de los datos útiles para descubrir eventos, no intentar construir una copia perfecta y exhaustiva de cada página fuente.

---

## 4. Dos problemas distintos: harvesting y discovery

La v3 separa explícitamente dos tipos de trabajo.

### 4.1 Harvesting

Sabemos dónde buscar.

Ejemplos:

- teatros;
- auditorios;
- orquestas;
- ciclos;
- fundaciones;
- festivales recurrentes;
- conservatorios con agenda estable;
- cualquier fuente ya incorporada al registro de fuentes.

La pregunta es:

> ¿Qué eventos publica ahora esta fuente para nuestra ventana temporal?

Este problema debe resolverse principalmente mediante código y adapters específicos o genéricos.

### 4.2 Discovery

No sabemos todavía dónde buscar.

Ejemplos:

- conciertos aislados en iglesias;
- pequeñas asociaciones;
- coros amateurs;
- recitales anunciados sólo en una agenda secundaria;
- nuevos festivales;
- centros culturales poco visibles;
- publicaciones en redes sociales;
- nuevas fuentes recurrentes que todavía no conocemos.

La pregunta es:

> ¿Qué eventos relevantes estamos perdiendo y de qué nuevas fuentes provienen?

Este problema es mucho más adecuado para agentes con capacidad de búsqueda e interpretación.

### 4.3 El ciclo de aprendizaje

Cada descubrimiento debe intentar reducir trabajo futuro.

```text
Discovery con IA
      ↓
encuentra evento
      ↓
¿proviene de una fuente recurrente útil?
      ├── sí → añadir/evaluar source adapter
      └── no → procesar como evento puntual
```

La cobertura determinista debería crecer con el tiempo, aunque la búsqueda abierta siga existiendo siempre para la larga cola.

---

## 5. Arquitectura objetivo

```text
                     ┌────────────────────────┐
                     │    SOURCE REGISTRY     │
                     │   fuentes conocidas    │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │    SOURCE ADAPTERS     │
                     │ JSON / JSON-LD / ICS   │
                     │ HTML / custom adapters │
                     └───────────┬────────────┘
                                 │
                                 ▼
                            RawEvent[]
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │       NORMALIZE        │
                     │ hechos y forma común   │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │        ENRICH          │
                     │ reglas + knowledge     │
                     │ base + IA              │
                     └───────────┬────────────┘
                                 │
                                 ▼
                            Candidate[]
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │ MATCH / DEDUP / DIFF   │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │ VALIDATE / APPLY BATCH │
                     └───────────┬────────────┘
                                 │
                                 ▼
                              data/**
                                 │
                                 ▼
                              PR / CI
                                 │
                                 ▼
                              merge


             PROCESO COMPLEMENTARIO DE DISCOVERY

                    Codex / Cursor / agente
                              │
                              ▼
                  nuevos eventos / fuentes
                              │
                              ▼
                         RawEvent[]
                              │
                              └────→ mismo pipeline
```

La pieza clave es que harvesting y discovery convergen pronto en el mismo contrato intermedio y reutilizan las mismas reglas de normalización, enriquecimiento, deduplicación y validación.

---

## 6. Tecnología: copiar patrones, no plataformas

La investigación de v2 identificó buenos patrones en City Scrapers, OpenSanctions, Scrapy, Airbyte, Singer/Meltano, dlt y otros proyectos.

La v3 conserva especialmente estas ideas:

- adapter independiente por fuente;
- modelo intermedio común;
- pipelines compartidos para normalización y validación;
- strict interpretation ante estructuras inesperadas;
- conocimiento persistente para aliases y decisiones repetidas;
- procesamiento batch;
- comparación con resultados anteriores;
- aislamiento de fallos por fuente;
- IA después de filtros y reglas baratas;
- separación entre extracción y publicación.

Pero no se propone adoptar esas plataformas completas.

Mientras el volumen lo permita, la implementación preferida es código TypeScript dentro de la propia repo.

Estructura conceptual:

```text
src/ingestion/
  sources/
  extractors/
  pipeline/
  enrichment/
  knowledge/
  types/
  cli/
```

La estructura exacta puede adaptarse al código existente cuando se implemente.

---

## 7. Source Registry mínimo

La v3 mantiene la idea de un registro explícito de fuentes conocidas, pero debe empezar pequeño.

El registro describe **cómo encontrar y extraer eventos**, no la procedencia editorial publicada en `data/sources/`.

En la implementación de la fase 1 el registry apunta a la Source canónica por `catalogSourceId` y sólo lleva un `seedSource` para el caso en que esa entidad todavía no exista en el catálogo. El pipeline reutiliza la entidad del catálogo cuando ya está publicada. Eso no es un sistema de gestión de sources: es el mínimo para poder incorporar una fuente nueva sin duplicar la verdad editorial.

`Event.kind` no es un atributo de la source. El registry describe cómo encontrar y extraer eventos; la clasificación real (`kind`, `formats`, `eras`, `access`, eligibility) pertenece al enrichment. `provisionalKind` ya no existe.

Ejemplo conceptual:

```yaml
id: cndm
name: Centro Nacional de Difusión Musical
urls:
  - https://example.org/programacion
adapter: cndm
```

O para una fuente genérica:

```yaml
id: example-jsonld
name: Example
urls:
  - https://example.org/agenda
adapter: jsonld
```

No deben añadirse campos especulativos que ningún componente utilice todavía.

El registro podrá evolucionar más adelante con metadata como confianza, estado, notas de extracción o frecuencia si aparece una necesidad concreta.

---

## 8. Source Adapters

Cada source adapter tiene una responsabilidad limitada:

> convertir una fuente concreta en uno o varios `RawEvent` basados en información realmente observada.

Debe evitar:

- decidir cómo publicar;
- escribir directamente en `data/**`;
- crear PRs;
- resolver toda la deduplicación global;
- realizar clasificación musical compleja si esa tarea pertenece al enriquecimiento común;
- inferir `Event.kind` o elegibilidad editorial a partir de la source.

`extract` parsea el listing. La hidratación de fichas es una etapa posterior (`hydrate` en el adapter, orquestada por el pipeline). Un fallo de listing es un source failure; un fallo de ficha es local al evento.

### 8.1 Preferencia de extracción

Siempre que sea razonable, preferir en este orden aproximado:

1. endpoint JSON público utilizado por la fuente;
2. JSON-LD / Schema.org;
3. ICS o feeds;
4. HTML estructurado;
5. adapter custom;
6. extracción asistida por IA si la estructura no permite una solución robusta y sencilla.

El orden no es una regla rígida. Debe escogerse el input más estable, comprensible y barato de mantener.

### 8.2 Strict interpretation

Un adapter no debe inventar datos para completar una estructura inesperada.

Si la fuente cambia y el parser ya no entiende con seguridad una sección, debe:

- producir un fallo visible para esa fuente;
- conservar el resto de fuentes sanas;
- evitar publicar datos parcialmente interpretados como si fueran correctos.

Una extracción vacía es sospechosa cuando el documento **parece** contener calendario o eventos pero el parser no reconoce ninguno. Eso debe fallar de forma visible. Un calendario genuinamente vacío (estructura reconocida, días sin eventos) no es un error.

---

## 9. `RawEvent`: hechos antes que interpretación

La v3 introduce o formaliza un objeto intermedio mínimo que representa lo que sabemos de la fuente antes de convertirlo en una entidad canónica completa.

Ejemplo conceptual:

```ts
interface RawEvent {
  sourceKey: string;
  sourceUrl: string;
  externalId?: string;

  title: string;
  description?: string;
  dates: Array<{
    date: string;
    time?: string;
  }>;

  venueText?: string;
  organizerText?: string[];
  seriesText?: string;

  performersText?: string[];
  composersText?: string[];
  worksText?: string[];

  accessText?: string;
}
```

No es necesario adoptar exactamente esta interfaz. La idea importante es separar:

- **hechos extraídos**;
- **interpretaciones derivadas**;
- **entidades canónicas finales**.

Esto evita pedir a cada scraper que conozca todas las reglas del dominio.

---

## 10. Normalización compartida

Después de la extracción, una capa común transforma representaciones heterogéneas en una forma coherente.

Responsabilidades posibles:

- normalizar espacios, mayúsculas y puntuación;
- normalizar fechas y horas;
- reconocer venues ya existentes;
- reconocer organizers y series conocidas;
- reutilizar IDs canónicos;
- aplicar aliases persistidos;
- construir identificadores nuevos de forma determinista cuando corresponda;
- convertir distintos formatos de performers, composers y works a estructuras homogéneas.

La normalización debe acumular conocimiento para no volver a resolver eternamente los mismos casos.

Ejemplo conceptual:

```text
"Auditorio Nacional"
"Auditorio Nacional de Música"
        ↓
ven_auditorio_nacional
```

La IA puede ayudar a decidir un caso ambiguo por primera vez, pero una decisión estable debería convertirse después en conocimiento reutilizable cuando resulte práctico.

---

## 11. Enrichment: clasificación como fase de primera clase

La v3 separa explícitamente extracción y clasificación.

Un extractor determinista puede conocer perfectamente que un concierto incluye a una orquesta, determinadas obras y ciertos compositores sin poder concluir de forma fiable qué `formats` o `eras` corresponden.

Por eso el pipeline incluye una fase de **enriquecimiento** posterior a la normalización.

```text
listing harvest
      ↓
detail-page hydration / observed facts
      ↓
eligibility
      ↓
formats / eras / kind / access
      ↓
confidence / evidence
      ↓
Candidate
```

La fase 1 se queda en el listado. La fase 2.1 hidrata fichas y acumula hechos observados. A partir de la fase 2.2, el enrichment no debe clasificar sólo con el título del calendario cuando exista una ficha.

Eligibility tiene prioridad: un `exclude` no debe consumir trabajo innecesario de clasificación posterior. Un `uncertain` degrada de forma segura y **no se publica automáticamente**.

```text
RawEvent
   ↓
Normalize
   ↓
Enrich
   ├── reglas deterministas
   ├── knowledge base musical
   └── IA
```

### 11.1 Campos prioritarios de enriquecimiento

Especialmente:

- `eras[]`;
- `formats[]`;
- `kind` — contexto del evento (`established` / `alternative`), no naturaleza de la source;
- `access`;
- elegibilidad / relevancia respecto al alcance de Clásica Madrid;
- roles de intérpretes cuando puedan inferirse con suficiente seguridad;
- otros campos derivados que se incorporen en el futuro.

`kind` no debe inferirse de forma permanente a partir de la source. Una sala o un calendario “clásicos” pueden publicar eventos que no son `established`, y una agenda municipal puede incluir tanto circuitos estables como propuestas alternativas.

### 11.2 Principio de preferencia

El enriquecimiento debe usar, aproximadamente:

```text
hecho explícito
    ↓
regla determinista segura
    ↓
conocimiento musical persistido
    ↓
IA
    ↓
fallback seguro
```

No debemos gastar razonamiento de modelo en una clasificación que puede deducirse inequívocamente mediante reglas simples.

### 11.3 Elegibilidad y relevancia

Estar publicado en un venue o source habitualmente clásicos **no implica** que el evento pertenezca al alcance de Clásica Madrid.

Una source válida puede mezclar música clásica, danza, charlas, actividades educativas, pop, electrónica u otros eventos musicales. El criterio de producto es que el evento tenga un componente claro de interpretación o programación de repertorio del ámbito de la música clásica.

Esta puerta de elegibilidad es responsabilidad de la **fase 2** (enrichment), no del harvesting. El harvesting debe extraer hechos; el enrichment decide si el evento es publicable.

La política vigente es [`docs/classification-policy.md`](classification-policy.md) (v1). El golden set de evaluación está en `tests/fixtures/ingestion/golden/`.

Tri-state interno (no es un campo del schema canónico `Event`):

```text
include   → puede continuar hacia Candidate
exclude   → se descarta
uncertain → no se publica automáticamente
```

Principios:

- reglas deterministas para los casos evidentes;
- IA sólo cuando aporte valor;
- no inventar;
- un caso incierto debe degradar de forma segura (no publicar como si fuera un sí);
- un evento claramente fuera de ámbito no debe publicarse;
- una source no determina por sí sola la elegibilidad;
- `eligibility ≠ format ≠ kind ≠ source`.

---

## 12. Classification Policy

La consistencia de la agenda depende más de una política editorial estable que del modelo concreto utilizado.

La v3 debe acompañarse de una **Classification Policy** implementada como reglas, documentación y tests. La v1 humana está en [`docs/classification-policy.md`](classification-policy.md). Los casos de evaluación están en `tests/fixtures/ingestion/golden/`. La implementación ejecutable (reglas, knowledge, IA) pertenece a la fase 2.

### 12.1 `formats[]`

Los formatos actuales son:

- `symphonic`;
- `chamber`;
- `recital`;
- `choral`;
- `organ`;
- `early-music`;
- `opera`;
- `zarzuela`;
- `lied`;
- `other`.

Los formatos no son necesariamente excluyentes.

Ejemplos conceptuales:

```text
orquesta sinfónica protagonista
→ symphonic

solista solo
→ recital

cuarteto de cuerda
→ chamber

coro + orquesta
→ choral + symphonic

recital de órgano
→ organ + recital

Lied con cantante y piano
→ lied + recital
```

Las reglas exactas deben codificarse y testearse a medida que aparezcan casos reales.

### 12.2 `eras[]`

Las épocas actuales son:

- `early`;
- `renaissance`;
- `baroque`;
- `classical`;
- `romantic`;
- `twentieth`;
- `contemporary`.

La política recomendada es:

1. cuando conocemos las obras con suficiente precisión, clasificar prioritariamente por las obras interpretadas;
2. si no conocemos las obras pero sí los compositores, utilizar una clasificación habitual del compositor como fallback;
3. permitir varias épocas en programas mixtos;
4. no forzar una categoría cuando la evidencia sea insuficiente.

Ejemplo:

```text
Bach + Mozart + Brahms
→ baroque + classical + romantic
```

La frontera exacta entre `twentieth` y `contemporary`, y otros casos musicológicamente ambiguos, está documentada de forma operativa en [`docs/classification-policy.md`](classification-policy.md). No se cambia el schema para resolver esa ambigüedad.

### 12.3 Knowledge base musical

Puede mantenerse una pequeña base de conocimiento propia para resolver casos repetitivos sin IA.

Ejemplo conceptual:

```json
{
  "Johann Sebastian Bach": ["baroque"],
  "Wolfgang Amadeus Mozart": ["classical"],
  "Franz Schubert": ["romantic"]
}
```

Puede ampliarse con obras, ensembles, roles u otras asociaciones si demuestra utilidad real.

Debe evitarse convertirla prematuramente en una enciclopedia musical completa.

---

## 13. Uso de IA en enrichment

La IA es especialmente adecuada cuando los hechos han sido extraídos pero necesitan interpretación.

En vez de pedir a un agente que navegue por toda la web, el sistema puede proporcionar un contexto acotado:

```text
TITLE
DESCRIPTION
PERFORMERS
COMPOSERS
WORKS
```

junto con:

- las taxonomías cerradas;
- la Classification Policy;
- reglas como "no inventes información ausente";
- el schema de salida esperado.

Salida conceptual:

```json
{
  "formats": ["symphonic"],
  "eras": ["romantic", "twentieth"],
  "confidence": "high",
  "evidence": [
    "programa orquestal",
    "repertorio identificado"
  ]
}
```

`confidence` y `evidence` pueden ser metadata interna del pipeline y no tienen que publicarse.

### 13.1 Clasificación obligatoria como objetivo, no como hard stop

La v3 intentará siempre producir `eras` y `formats`.

Sin embargo:

> un evento bien identificado, fechado, localizado y respaldado por una fuente fiable no debe quedar fuera de la agenda únicamente porque una clasificación musical no haya podido resolverse con suficiente seguridad.

Por tanto:

- `eras` y `formats` vacíos generan señal/telemetría;
- el pipeline puede intentar una segunda estrategia de enrichment;
- el evento puede publicarse igualmente si supera las validaciones esenciales;
- ejecuciones posteriores pueden completar o corregir la clasificación.

---

## 14. Datos esenciales frente a datos enriquecidos

La v3 distingue tres niveles prácticos.

### 14.1 Datos esenciales

Deben tener alta fiabilidad para publicar:

- identidad razonable del evento;
- fecha;
- hora si la fuente la proporciona;
- lugar;
- título;
- URL fuente;
- estado;
- procedencia y fecha de comprobación.

### 14.2 Datos de descubrimiento

Muy importantes y deben intentarse siempre:

- intérpretes;
- compositores;
- `formats`;
- `eras`;
- `kind`;
- `access`.

### 14.3 Datos secundarios

No deben convertir la ingestión en un sistema frágil:

- programa completo cuando no esté disponible;
- descripciones extensas;
- precios detallados;
- biografías;
- información comercial exhaustiva;
- detalles que ya están bien cubiertos por la fuente original.

---

## 15. Codex y Cursor como capacidades de primera clase, no dependencias críticas

La intención es utilizar Codex y Cursor siempre que resulte útil, especialmente para:

- discovery abierto;
- extracción de fuentes difíciles;
- clasificación y enrichment ambiguos;
- resolución de excepciones;
- creación de nuevos source adapters;
- reparación de adapters rotos;
- análisis de cambios inesperados en una web;
- generación o mejora de tests;
- investigación de posibles duplicados complejos.

Pero el pipeline debe conservar una ruta funcional sin agentes.

Esto implica distinguir entre:

```text
pipeline esencial
≠
dependencia obligatoria de un proveedor de IA
```

La implementación debería encapsular las llamadas a IA detrás de interfaces pequeñas para poder:

- ejecutar sin IA;
- cambiar de proveedor o herramienta;
- usar Codex, Cursor u otros modelos según disponibilidad;
- testear el pipeline sin llamadas externas.

### 15.1 IA preferida, pero con degradación segura

En una ejecución ordinaria:

1. se intenta utilizar IA para los pasos configurados de enrichment o discovery;
2. si esa capacidad no está disponible, harvesting continúa;
3. reglas y knowledge base siguen enriqueciendo todo lo posible;
4. la ausencia de IA no debe corromper ni bloquear el catálogo entero;
5. los campos no resueltos quedan para una ejecución posterior cuando corresponda.

---

## 16. Candidate como contrato lógico, no como fichero obligatorio

`Candidate` sigue siendo una frontera útil entre datos extraídos/enriquecidos y datos canónicos.

Pero la v3 no debe asumir:

```text
1 evento
→ 1 candidate JSON
→ inbox
→ commit
→ promoción manual
```

En el flujo automático normal:

```text
RawEvent[]
    ↓
Candidate[]
    ↓
validate batch
    ↓
apply batch
```

Los candidatos pueden existir únicamente en memoria durante la ejecución.

`ingestion/inbox/` sigue siendo útil para:

- imports manuales;
- debugging;
- pruebas;
- handoffs con agentes;
- fixtures temporales;
- inspección de casos excepcionales.

Pero no debe ser una cola persistente obligatoria para cada evento rutinario.

---

## 17. Imports de IA en batch

Cuando un agente haga discovery o extracción abierta, no debería modificar físicamente cientos de JSON canónicos uno a uno.

La interfaz preferida es que produzca un batch estructurado, por ejemplo:

```text
ingestion/imports/2026-08-29-discovery.jsonl
```

O entregue el conjunto directamente a una CLI.

El agente se concentra en:

- investigación;
- selección de fuentes;
- extracción de hechos;
- justificación cuando sea necesaria.

El código se concentra en:

- IDs;
- normalización;
- entity matching;
- aliases;
- deduplicación;
- schemas;
- escritura canónica;
- orden y formato;
- validación.

Esto reduce uso de agentes y hace reproducible la transformación final.

---

## 18. Procesamiento batch y atomicidad

La v3 debe procesar la ejecución como conjunto.

Responsabilidades:

1. cargar catálogo canónico;
2. obtener los `RawEvent` de todas las fuentes sanas;
3. normalizar;
4. enriquecer;
5. resolver entidades compartidas;
6. detectar duplicados dentro del lote;
7. comparar contra el catálogo actual;
8. construir el catálogo resultante en memoria;
9. ejecutar validaciones;
10. escribir cambios coherentes.

Siempre que sea razonable, la escritura debe ser atómica a nivel de lote publicado.

Un fallo no debe dejar media ejecución aplicada.

En la fase 1 esto se implementa de forma local y simple: el lote se construye y valida en memoria; los archivos se escriben primero a un directorio temporal (`.ingest-tmp-*` dentro del árbol de datos); si la preparación termina bien, se mueven al destino; un fallo durante la preparación o el movimiento revierte lo ya publicado y limpia el temporal. No es un sistema transaccional genérico. La fase 1 sólo crea archivos nuevos.

---

## 19. Sincronización completa de una ventana de 120 días

La v3 evita inicialmente una arquitectura incremental sofisticada con cursores, checkpoints o estado distribuido.

Cada ejecución ordinaria revisa de nuevo la ventana móvil:

```text
HOY ─────────────────────────────────────────► HOY + 120 días
```

Para cada fuente conocida:

```text
fetch
  ↓
extract future events in window
  ↓
normalize + enrich
  ↓
compare with canonical catalog
  ↓
new / changed / unchanged / missing
```

Para el volumen previsto, volver a procesar una ventana de 120 días aproximadamente cada 10 días es suficientemente simple y robusto.

La optimización incremental sólo debe introducirse cuando exista evidencia de que hace falta.

---

## 20. Detectar cambios es tan importante como añadir eventos

La ingestión no es únicamente inserción.

Un evento ya publicado puede cambiar:

- fecha;
- hora;
- lugar;
- intérpretes;
- programa;
- estado;
- URL;
- acceso;
- clasificación derivada.

Por tanto, cada ejecución debe reconciliar el estado observado con el catálogo actual.

### 20.1 Desapariciones

Si un evento futuro que antes estaba en una fuente desaparece, no debe borrarse automáticamente sin interpretación.

Una desaparición puede significar:

- cancelación;
- reorganización de la web;
- URL cambiada;
- error temporal;
- fallo del adapter;
- evento retirado.

La política debe ser conservadora.

Un evento histórico nunca se elimina simplemente porque deje de aparecer en la fuente actual.

---

## 21. Deduplicación y entity resolution

La v3 aplica una estrategia escalonada:

1. `externalId` estable de la fuente cuando exista;
2. URL/event ID de origen;
3. IDs y aliases ya conocidos;
4. coincidencias fuertes de fecha, hora, lugar y título;
5. nombres normalizados;
6. comparaciones heurísticas/fuzzy sobre candidatos plausibles;
7. IA para ambigüedad residual.

La IA no debería comparar cada evento contra todo el catálogo.

Primero debe aplicarse blocking barato para reducir candidatos.

### 21.1 Persistir conocimiento útil

Cuando una decisión ambigua se repita con frecuencia, puede convertirse en regla o alias.

El sistema debe hacerse progresivamente más determinista sin intentar automatizar manualmente cada excepción desde el primer día.

---

## 22. Aislamiento de fallos por fuente

Una fuente rota no debe tirar toda la ejecución.

Ejemplo de resultado deseado:

```text
52 sources
49 OK
1 unavailable
2 parser failures

324 events observed
7 new
12 updated
305 unchanged
```

Las fuentes sanas pueden seguir produciendo cambios.

Una fuente problemática debe quedar claramente registrada y sus resultados dudosos no deben publicarse.

### 22.1 Diferencia entre fallo local y fallo global

**Fallo local:**

- timeout de una web;
- HTML inesperado en una fuente;
- parser roto;
- extracción vacía sospechosa.

Debe aislarse.

**Fallo global:**

- schema canónico inválido;
- corrupción de referencias;
- colisiones fuertes de identidad no resolubles;
- error que compromete la coherencia del lote final.

Debe impedir publicar el lote afectado.

---

## 23. Automatización: aproximadamente cada 10 días

La ejecución ordinaria se programa en GitHub Actions aproximadamente cada diez días.

GitHub Actions actúa como orquestador suficiente para esta fase porque ya proporciona:

- scheduling;
- runners;
- logs;
- secrets;
- artifacts;
- integración con Git;
- PRs;
- CI;
- historial de ejecuciones.

No se introduce un orquestador externo mientras esto sea suficiente.

### 23.1 Cadencia

GitHub Actions usa cron, que no expresa de forma natural "cada diez días" manteniendo intervalos exactos a través de todos los meses.

La implementación puede escoger una aproximación sencilla, por ejemplo:

- días 1, 11 y 21 de cada mes;
- o una ejecución periódica más frecuente con una condición interna basada en `lastSuccessfulRun`.

Para el producto, lo relevante es una cadencia aproximada de diez días, no una precisión horaria exacta.

### 23.2 Ejecución manual

Debe mantenerse `workflow_dispatch` o una CLI equivalente para poder ejecutar la ingestión bajo demanda durante desarrollo, debugging o antes de un lanzamiento.

---

## 24. Publicación sin intervención humana

El objetivo final de la v3 es que una ejecución sana complete por sí sola:

```text
fetch
→ extract
→ normalize
→ enrich
→ reconcile
→ validate
→ write
→ PR
→ CI
→ auto-merge
```

No se diseña el sistema alrededor de una revisión humana ordinaria.

### 24.1 Seguridad para conseguir 0 % intervención

Cero intervención no significa saltarse controles.

La confianza debe provenir de:

- adapters versionados;
- schemas estrictos;
- tests;
- validación de referencias;
- reglas de deduplicación;
- comparación con estado anterior;
- límites sobre qué paths puede tocar la automatización;
- CI obligatorio;
- PRs trazables;
- auto-merge sólo con checks verdes.

Cuando un caso no pueda resolverse, el comportamiento preferido es **degradar o excluir ese dato concreto**, no pedir revisión humana como parte necesaria del pipeline normal.

### 24.2 Casos irresolubles

Si una fuente o un evento concreto no puede procesarse con seguridad:

- se registra el fallo;
- se conserva el catálogo anterior;
- se continúa con el resto cuando sea seguro;
- una ejecución posterior puede recuperarlo;
- Codex/Cursor pueden utilizarse posteriormente para reparar el adapter de forma asistida.

La agenda debe poder seguir funcionando sin que cada excepción se convierta en una tarea manual obligatoria.

---

## 25. Discovery abierto con IA

El harvesting de fuentes conocidas nunca cubrirá toda la larga cola.

Periódicamente, idealmente dentro de la misma cadencia general o como job separado, los agentes pueden buscar:

- iglesias;
- parroquias y monasterios;
- conservatorios;
- escuelas de música;
- universidades;
- colegios mayores;
- centros culturales;
- embajadas e institutos culturales;
- fundaciones;
- asociaciones;
- agrupaciones amateurs;
- festivales pequeños;
- eventos gratuitos;
- agendas secundarias;
- plataformas de eventos;
- redes sociales;
- webs de intérpretes y ensembles.

El agente debe recibir contexto del catálogo y de las fuentes ya conocidas para concentrarse en huecos, no en reconstruir todo desde cero.

La tarea conceptual es:

> Busca eventos dentro de los próximos 120 días que probablemente no estén ya cubiertos por el catálogo ni por las fuentes conocidas. Devuelve hechos estructurados y detecta nuevas fuentes recurrentes aprovechables.

---

## 26. Observabilidad mínima

No necesitamos una plataforma de monitoring específica.

Cada ejecución debería producir un resumen legible y, cuando sea útil, un artifact estructurado.

Métricas mínimas:

```text
sources attempted
sources succeeded
sources failed
raw events extracted
new events
updated events
unchanged events
possible missing events
duplicates discarded
events enriched by rules
events enriched by IA
events with empty eras
events with empty formats
validation failures
```

Esto permitirá saber si la ingestión está sana sin inspeccionar manualmente cientos de ficheros.

---

## 27. Testing

La v3 debe invertir más en tests que en infraestructura.

### 27.1 Tests por source adapter

Cada adapter importante debería tener fixtures representativas y comprobar que:

- encuentra los eventos esperados;
- extrae fechas y URLs correctamente;
- no confunde navegación o contenido irrelevante con eventos;
- falla de forma visible ante una estructura inesperada.

### 27.2 Tests de normalización

Especialmente:

- aliases;
- venue matching;
- organizer matching;
- fechas;
- horas;
- generación de IDs;
- casos de colisión.

### 27.3 Tests de Classification Policy

El contrato del golden set (`tests/ingestion-golden.test.ts`) valida el dataset: schema, IDs únicos, tri-state, `uncertain` con evidencia faltante, y que source/venue no determinan eligibility.

La fase 2.2 ejecuta `golden.observed → classify()` (`tests/ingestion-golden-classify.test.ts`) con invariantes duros: cero `include` sobre expected exclude/uncertain; ningún expected include puede ser `exclude`. Sin IA, un include verdadero puede quedar `uncertain`. Las métricas viven en `src/ingestion/classification/metrics.ts`.

La fase 2.3 evalúa `golden.observed → classify() → AI fake si uncertain` (`tests/ingestion-golden-ai.test.ts`). CI no llama a un LLM: los tests inyectan fakes. Un fallo o ausencia de IA deja `uncertain`.

La fase 2.4 cubre el pipeline completo (`tests/ingestion-publication-gate.test.ts`): `listing → hydrate → normalize → classifyObserved → publication gate → Candidate`. Un `exclude` o `uncertain` nunca llega a Candidate. CI no llama a un LLM.

La IA no debe ser la única definición ejecutable de la política. CI no llama a un LLM.

### 27.4 Tests de reconciliación

Casos clave:

- nuevo evento;
- evento sin cambios;
- evento modificado;
- evento desaparecido;
- duplicado fuerte;
- dos representaciones del mismo evento;
- entidades compartidas entre varios candidatos;
- fallo de una source sin afectar a las demás.

---

## 28. Idempotencia

Una propiedad deseable de `ingest:sync` es:

> ejecutar dos veces consecutivas contra las mismas fuentes debería producir cero cambios en la segunda ejecución.

Esto simplifica:

- retries;
- debugging;
- ejecuciones manuales;
- recuperación después de fallos;
- confianza en la automatización.

La idempotencia debe ser una preocupación explícita de IDs, matching y escritura.

---

## 29. CLI objetivo

La implementación puede converger hacia una CLI pequeña y comprensible.

Ejemplos conceptuales:

```bash
npm run ingest:source -- cndm
npm run ingest:sync
npm run ingest:process -- ingestion/imports/discovery.jsonl
npm run ingest:validate
```

Opcionalmente:

```bash
npm run ingest:discover
npm run ingest:enrich
```

No es necesario implementar todos estos comandos exactamente. La intención es que las operaciones sean reproducibles y ejecutables sin depender de manipulación manual de archivos.

---

## 30. Flujo normal esperado

Una ejecución completa debería parecerse aproximadamente a esto:

```text
1. load source registry
2. load canonical catalog
3. fetch all enabled sources
4. extract RawEvent[] per source
5. isolate source failures
6. normalize all healthy RawEvent[]
7. hydrate detail pages / observed facts when needed
8. eligibility gate (include / exclude / uncertain)
9. enrich formats / eras / kind / access
10. run optional AI enrichment with safe fallback
11. reconcile entities and deduplicate globally
12. compare with current 120-day catalog
13. construct resulting catalog in memory
14. validate schemas + references + domain rules
15. write coherent changes
16. run tests/build/validation
17. create or update ingestion PR
18. CI
19. auto-merge if green
20. emit run summary
```

Discovery puede ejecutarse antes del paso 6 o como job independiente que produce nuevos `RawEvent[]` para el mismo pipeline.

---

## 31. Qué NO hacer en v3

Salvo que aparezca una necesidad demostrable, no debemos introducir ahora:

- PostgreSQL/Supabase como almacenamiento de ingestión;
- Redis;
- Kafka;
- colas de mensajes;
- Airbyte;
- Meltano;
- Dagster;
- Prefect;
- Temporal;
- servicios de scraping comerciales;
- vector databases para deduplicación;
- un microservicio por fuente;
- Docker obligatorio para cada adapter;
- infraestructura de agentes multi-agent compleja;
- un sistema de revisión humana obligatorio;
- cursores incrementales sofisticados;
- un data lake de snapshots de todas las fuentes;
- schemas dinámicos generados automáticamente.

Estas tecnologías podrían ser apropiadas algún día, pero deben responder a problemas observados, no anticipados.

---

## 32. Plan de implementación recomendado

### Fase 1 — contratos y vertical slice

Objetivo: demostrar el pipeline completo con pocas fuentes.

- definir `RawEvent`;
- definir interfaz `SourceAdapter`;
- crear source registry mínimo;
- implementar 2–3 fuentes representativas;
- normalización común;
- transformación a Candidate;
- batch validation/apply;
- ejecución idempotente local;
- hardening de parsers estrictos, IDs/slugs, URLs, fechas Madrid/UTC, escritura atómica y CLI.

Elegir fuentes diferentes entre sí ayuda a validar la abstracción, por ejemplo:

- una fuente con JSON/JSON-LD;
- una fuente HTML;
- una fuente que necesite adapter custom.

### Fase 2 — enrichment

**Preparación (hecha):** Classification Policy v1 y golden evaluation set. Phase 2 se mide contra esos casos, no contra una impresión subjetiva posterior.

**2.1 Observed facts + detail hydration (hecha):** `RawEvent.observed` alineado con el golden set; hidratación orquestada fuera de `extract()`; parsers de ficha para Auditorio Nacional y Teatro Real; un fallo de ficha es local al evento. Madrid Datos no hidrata (el JSON-LD ya trae los hechos).

**2.2 Deterministic classification core (hecha):** `ObservedFacts → classify()` en `src/ingestion/classification/`. Eligibility conservadora (`include` / `exclude` / `uncertain`) con short-circuit; formats/eras/kind/access sólo si `include`; knowledge base mínima de compositores en `src/ingestion/knowledge/composers.ts`; `access` se resuelve sólo desde `accessText`. Evidence interna (`Resolution`), no confidence numérica.

**2.3 AI fallback (hecha):** `classifyObserved()` en `src/ingestion/classification/enrich.ts`. Sólo llama a `AiClassifier` cuando el determinista devuelve `uncertain` (máximo una llamada). Un `include`/`exclude` determinista no se reabre. La respuesta se valida con Zod contra las taxonomías canónicas. Ausencia de provider, timeout, error, JSON inválido o valores fuera de taxonomía → `eligibility = uncertain` con `ruleId` diagnóstico (`ai-unavailable`, `ai-timeout`, `ai-error`, `ai-malformed-output`, `ai-invalid-output`). Provider real: OpenAI Chat Completions vía `fetch` (`OPENAI_API_KEY`); CI y tests usan fakes, nunca un LLM.

**2.4 Pipeline integration + publication gate (hecha):** `runIngest` proyecta `NormalizedEvent → ObservedFacts` (`observedFactsFromNormalized`), llama a `classifyObserved`, y sólo convierte en Candidate un `include` publicable. `exclude` y `uncertain` no se publican, no consumen IDs/slugs y no se mezclan con `skippedUnusable`. El Candidate usa `formats` / `eras` / `kind` / `access` del `ClassificationResult`. `kind` ya no viene de la source: `provisionalKind` se ha eliminado. La CLI (`src/cli/ingest.ts`) construye como máximo un `AiClassifier` por ejecución con `createAiClassifierFromEnv()` y lo inyecta; `runIngest` no lee env. Sin API key el pipeline determinista funciona y los `uncertain` no se publican. Los eventos ya publicados en `data/**` no se borran ni se re-clasifican: esta puerta aplica a nuevos resultados de harvesting.

**PHASE 2 COMPLETE.**

Flujo productivo:

```text
listing harvest
      ↓
detail-page hydration / observed facts
      ↓
normalize
      ↓
ObservedFacts (proyección explícita, sin metadata técnica)
      ↓
deterministic classify()
      ↓
include / exclude → resultado final
uncertain → AI fallback (si hay provider) → include | exclude | uncertain
      ↓
publication gate
      ├── include + kind → Candidate enriquecido
      ├── exclude → no publicar
      └── uncertain → no publicar
      ↓
batch validation → data/**
```

Acceptance criteria: [`docs/classification-policy.md`](classification-policy.md) §7.

### Fase 3 — reconciliation

- matching contra catálogo;
- aliases;
- deduplicación batch;
- detección de updates;
- política conservadora de desapariciones;
- tests de idempotencia.

### Fase 4 — automatización GitHub

- workflow scheduled;
- ventana de 120 días;
- aproximadamente cada 10 días;
- PR automática;
- CI obligatorio;
- auto-merge de cambios de datos válidos;
- logs/resumen de ejecución.

### Fase 5 — ampliar fuentes conocidas

Añadir adapters progresivamente, priorizando cobertura y estabilidad.

Cada fuente recurrente descubierta debe evaluarse para pasar al registry.

### Fase 6 — discovery con agentes

- definir input/contexto del agente;
- devolver batch estructurado;
- procesarlo por el pipeline común;
- detectar nuevas sources;
- utilizar Codex/Cursor para reparar o crear adapters cuando resulte útil.

---

## 33. Criterios de éxito de la v3

La v3 puede considerarse exitosa cuando:

1. una ejecución se puede lanzar con un único comando;
2. GitHub Actions la ejecuta aproximadamente cada diez días;
3. mantiene automáticamente los próximos 120 días;
4. una fuente rota no bloquea las fuentes sanas;
5. una segunda ejecución sin cambios no modifica la repo;
6. eventos nuevos y actualizados se detectan automáticamente;
7. `eras` y `formats` se completan en la gran mayoría de eventos;
8. una clasificación irresoluble no bloquea un evento esencialmente fiable;
9. Codex/Cursor mejoran discovery, enrichment y mantenimiento cuando están disponibles;
10. la ausencia temporal de IA no inutiliza harvesting;
11. los cambios válidos llegan hasta merge sin intervención humana;
12. todo evento publicado conserva trazabilidad hacia su fuente original;
13. el pipeline sigue siendo entendible por una sola persona leyendo la repo.

---

## 34. Principio final

La ingestión de Clásica Madrid no necesita convertirse en una plataforma de ingeniería de datos.

Necesita ser un pequeño sistema fiable de sincronización y descubrimiento de eventos.

La arquitectura v3 debe optimizar para:

```text
simplicidad
+ cobertura
+ trazabilidad
+ automatización
+ capacidad de recuperación
+ IA pragmática
```

antes que para sofisticación técnica.

Cuando haya que elegir entre una solución elegante pero compleja y una solución sencilla que mantenga correctamente el catálogo, la v3 debe preferir la segunda.
