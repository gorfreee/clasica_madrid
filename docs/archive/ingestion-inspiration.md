# Ingestión — investigación e inspiración externa

> **Documentación histórica.** Este documento **no** representa la arquitectura vigente y **no** debe usarse como especificación de implementación.
>
> La referencia actual para la evolución de la ingestión es [`docs/ingestion-v3-plan.md`](../ingestion-v3-plan.md). El estado operativo de lo que hay implementado hoy está en [`docs/ingestion.md`](../ingestion.md).
>
> Consérvese como investigación de fondo. Sólo úsalo como requisito si una tarea pide explícitamente investigar decisiones o patrones anteriores.

> Estado original: **documento de investigación**. Complementa [`docs/archive/ingestion-v2-plan.md`](ingestion-v2-plan.md) y recoge patrones observados en proyectos open source que resuelven problemas relacionados con ingestión, crawling, normalización, sincronización incremental, deduplicación y publicación de datos heterogéneos.
>
> No es una especificación de implementación. Las ideas se valoran por su utilidad para Clásica Madrid, no porque debamos adoptar las tecnologías completas de los proyectos estudiados.

## 1. Objetivo de esta investigación

Clásica Madrid necesita mantener un catálogo de eventos procedentes de muchas fuentes con características muy distintas:

- APIs y feeds estructurados;
- páginas HTML relativamente estables;
- webs JavaScript;
- calendarios ICS;
- PDFs y carteles;
- agendas de terceros;
- pequeñas instituciones con webs irregulares;
- fuentes descubiertas mediante búsqueda abierta;
- información que puede cambiar después de la primera publicación.

El problema no es solamente **extraer eventos una vez**, sino mantener un catálogo fiable en el tiempo sin reconstruir toda la agenda mediante un agente de IA en cada ejecución.

Para buscar patrones reutilizables se han revisado proyectos de varias familias:

1. agregadores/scrapers de eventos;
2. frameworks de crawling;
3. sistemas de integración de datos y conectores;
4. proyectos de datos públicos con muchas fuentes heterogéneas;
5. herramientas de deduplicación y entity resolution;
6. herramientas de change detection;
7. orquestadores de pipelines.

---

# 2. Referencias estudiadas

## City Scrapers

Repositorios:

- https://github.com/City-Bureau/city-scrapers
- https://github.com/City-Bureau/city-scrapers-core
- https://github.com/City-Bureau/city-scrapers-template

**Por qué es especialmente relevante:** City Scrapers recoge reuniones públicas dispersas entre muchas webs institucionales, las estandariza bajo un modelo común y ejecuta los scrapers periódicamente. El problema operativo es muy parecido al de Clásica Madrid aunque el dominio sea diferente.

Patrones observados:

- un scraper independiente por fuente;
- todos producen el mismo tipo de `Meeting`;
- scraping basado en Scrapy;
- pipelines posteriores para defaults, validación, transformación y diff;
- GitHub Actions para ejecutar todos los scrapers diariamente;
- salida JSON/JSONL independiente de la web de presentación;
- tests por scraper;
- comparación con resultados anteriores para conservar IDs y detectar reuniones que desaparecen;
- una reunión futura que existía antes y deja de aparecer puede marcarse como cancelada en vez de borrarse silenciosamente.

La clase `DiffPipeline` es particularmente interesante: carga el resultado anterior, conserva la identidad estable de los registros que siguen existiendo y procesa también los registros futuros antiguos que ya no aparecen en el nuevo crawl para marcarlos como cancelados.

### Ideas aprovechables

- **source adapter = unidad básica de mantenimiento**;
- cada fuente sabe extraer, pero no sabe publicar;
- la limpieza/validación vive en pipelines compartidos;
- comparar cada crawl con el anterior es tan importante como descubrir eventos nuevos;
- una desaparición de la fuente es una señal que requiere interpretación, no un `delete` automático;
- los scrapers deben ejecutarse de forma independiente: el fallo de una fuente no bloquea las demás;
- las fuentes necesitan tests propios porque sus estructuras cambian.

---

## Scrapy y scrapy-deltafetch

Repositorios/documentación:

- https://github.com/scrapy/scrapy
- https://github.com/scrapy-plugins/scrapy-deltafetch
- https://docs.scrapy.org/

Scrapy separa claramente:

```text
requests/fetch
    ↓
spider / source parser
    ↓
items
    ↓
item pipelines
    ↓
export / persistence
```

Los `Item Pipelines` concentran tareas como limpieza, validación, deduplicación y persistencia, evitando duplicarlas dentro de cada scraper.

Otros mecanismos relevantes:

- request fingerprints para evitar solicitudes duplicadas;
- HTTP cache;
- retries;
- throttling;
- estadísticas por spider;
- JSON Lines como formato natural para streams de registros;
- `scrapy-deltafetch`, que mantiene fingerprints entre crawls y permite evitar páginas ya procesadas cuando la semántica de la fuente lo permite.

### Ideas aprovechables

No es imprescindible adoptar Scrapy, pero sí copiar su separación de responsabilidades:

```text
Fetcher → Source Adapter → RawEvent → Shared Pipeline
```

Además, la ejecución debería tener mecanismos para **no descargar o reprocesar trabajo conocido innecesariamente**.

---

## OpenSanctions + zavod

Repositorios/documentación:

- https://github.com/opensanctions/opensanctions
- https://zavod.opensanctions.org/
- https://www.opensanctions.org/docs/opensource/

OpenSanctions es una de las referencias más valiosas conceptualmente. Ingieren multitud de fuentes públicas heterogéneas, muchas de ellas semiestructuradas y con inconsistencias, y las transforman a un modelo canónico común.

Cada dataset tiene dos piezas principales:

```text
metadata YAML
    +
crawler específico
```

La metadata describe la fuente, publisher, URLs, entry point, configuración HTTP y otros aspectos. El crawler se centra en interpretar esa fuente.

### Strict interpretation

Una filosofía especialmente interesante es que, cuando el crawler encuentra una situación que no puede interpretar de forma segura, debe generar un error o detenerse en vez de producir datos ambiguos.

Esto encaja muy bien con Clásica Madrid:

> mejor dejar un evento pendiente que publicar silenciosamente una inferencia incorrecta.

### Lookups declarativos

OpenSanctions utiliza `lookups` para resolver irregularidades recurrentes de una fuente.

Ejemplo conceptual:

```text
"Auditorio Nac. de Música" → ven_auditorio_nacional
"Auditorio Nacional"       → ven_auditorio_nacional
```

La idea importante es que una excepción conocida se convierte en **conocimiento persistente y revisable**, no en razonamiento que haya que repetir en cada ejecución.

### Caching y recursos fuente

`zavod` proporciona helpers para descargar recursos, cachearlos y conservarlos como parte del contexto del crawl.

Esto permite:

- reproducir una ejecución;
- inspeccionar qué contenido produjo los datos;
- evitar descargas repetidas durante desarrollo;
- investigar cambios de una fuente.

### Change detection separado de extraction

OpenSanctions documenta explícitamente que la detección de cambios puede ser una tarea diferente de la extracción.

Si una fuente no puede interpretarse completamente de forma determinista, se puede vigilar un:

- hash;
- URL de documento;
- versión;
- fecha de publicación;
- nodo HTML estable.

Cuando cambia, se dispara revisión/extracción.

Esto evita hacer trabajo caro cuando el contenido relevante no ha cambiado.

### Ideas aprovechables

- metadata declarativa por fuente;
- crawler/adaptador separado;
- strict interpretation;
- cache/snapshot del material fuente;
- issues estructurados producidos durante la extracción;
- aliases/lookups declarativos;
- change detection antes de extracción cara;
- escoger **el input estable más pequeño posible** para detectar cambios;
- si una fuente cambia de estructura inesperadamente, fallar visiblemente en vez de producir resultados parciales engañosos.

---

## Nomenklatura — deduplicación de OpenSanctions

Repositorio:

- https://github.com/opensanctions/nomenklatura

Nomenklatura separa dos tareas que con frecuencia se mezclan:

1. generar candidatos de posible duplicado;
2. decidir si realmente representan la misma entidad.

Su pipeline conceptual es:

```text
entities
   ↓
blocking
   ↓
candidate pairs
   ↓
scoring
   ↓
judgement
   ↓
resolver
   ↓
canonical entity
```

La idea más importante para Clásica Madrid no es utilizar Nomenklatura sino **persistir decisiones de identidad**.

Si una vez decidimos que:

```text
"OCNE"
"Orquesta y Coro Nacionales de España"
```

representan la misma entidad, esa decisión no debería volver a depender de fuzzy matching o de un LLM en futuras ejecuciones.

Nomenklatura también distingue juicios positivos, negativos y dudosos. Esto sugiere que para casos ambiguos podemos conservar explícitamente:

```text
same
not-same
review
```

### Ideas aprovechables

- blocking barato antes de comparación cara;
- fuzzy/IA solamente sobre candidatos plausibles;
- decisiones de merge/no-merge persistentes;
- identidad canónica separada de las distintas formas de nombre;
- revisión humana para casos inciertos;
- las decisiones humanas pasan a formar parte del sistema.

---

## Airbyte

Repositorio/documentación:

- https://github.com/airbytehq/airbyte
- https://docs.airbyte.com/

Airbyte es mucho más pesado que lo necesario para Clásica Madrid, pero su arquitectura de conectores contiene patrones útiles.

### Connector registry

Airbyte mantiene un catálogo explícito de conectores con metadata sobre:

- nombre;
- versión;
- lenguaje;
- documentación;
- soporte;
- capacidades.

Esto refuerza la idea de que Clásica Madrid debería tener un **source registry** versionado.

### Declarative connectors

Airbyte observó que muchos conectores HTTP repiten las mismas necesidades:

- base URL/path;
- autenticación;
- paginación;
- selección de registros;
- retries y backoff;
- cursor incremental;
- transformaciones;
- schema.

Por eso ofrece conectores definidos mediante manifests YAML en vez de obligar a escribir código para cada fuente.

Para Clásica Madrid esto sugiere una arquitectura híbrida:

```text
fuentes sencillas → configuración declarativa
fuentes complejas → adapter TypeScript específico
```

No todas las webs necesitan un fichero de código nuevo.

### Incremental state / cursor

Airbyte trata el estado incremental como contrato de primera clase. Una fuente puede guardar un cursor (`updated_at`, ID, página, etc.) y continuar desde allí en la siguiente ejecución.

### Ideas aprovechables

- source registry explícito;
- metadata y versión del adapter;
- configuración declarativa para patrones repetidos;
- comando `check` por fuente para comprobar rápidamente que sigue funcionando;
- estado incremental por fuente;
- retries/backoff centralizados;
- niveles de soporte/confianza por source;
- interfaz común aunque la implementación interna sea distinta.

### Qué no copiar

No necesitamos la plataforma Airbyte, Docker por conector, catálogo remoto ni su infraestructura de ejecución. El patrón es más valioso que la herramienta.

---

## Singer / Meltano

Repositorios/documentación:

- https://github.com/meltano/meltano
- https://github.com/meltano/sdk
- https://github.com/meltano/hub

Singer introdujo una separación muy limpia:

```text
Tap (extractor) → records/state → Target (loader)
```

Meltano añade gestión de plugins, configuración y estado.

### Streams y state

Cada extractor puede producir distintos streams y emitir `STATE` con bookmarks que permiten continuar la sincronización.

El estado está separado del output y puede inspeccionarse o restaurarse.

### Plugin catalog

Meltano Hub actúa como un registro de extractores/loaders independientes.

### Ideas aprovechables

- extraction y loading como contratos independientes;
- el estado de sincronización pertenece a la source, no al evento;
- el estado debe poder inspeccionarse y resetearse;
- interfaces pequeñas para adapters;
- configuración separada de código;
- poder ejecutar una source individualmente para debugging.

---

## dlt

Repositorio/documentación:

- https://github.com/dlt-hub/dlt
- https://dlthub.com/docs/

`dlt` es una biblioteca de ingestión mucho más ligera que Airbyte y tiene varias ideas interesantes:

- extracción desde Python/APIs/files;
- normalización;
- incremental loading;
- estado persistido;
- schema evolution;
- schema contracts;
- merge/upsert;
- inspección del pipeline.

### Lag / attribution window

Una idea especialmente relevante es no confiar siempre en un cursor rígido. `dlt` soporta volver a procesar una pequeña ventana reciente para capturar modificaciones tardías.

Para eventos esto es muy útil.

En vez de:

```text
"ya procesé hasta el 20 de agosto; nunca vuelvo atrás"
```

podemos hacer:

```text
cada ejecución revalida una ventana reciente/futura solapada
```

porque los eventos pueden cambiar después de ser descubiertos.

### Schema contracts

`dlt` permite decidir qué ocurre cuando una fuente cambia el schema: evolucionar, rechazar o descartar.

En Clásica Madrid deberíamos ser conservadores: un cambio inesperado en la estructura de un adapter de confianza debería generar fallo/revisión, no modificar automáticamente el modelo canónico.

### Ideas aprovechables

- state por pipeline/source;
- upsert idempotente;
- ventana de solapamiento;
- contratos estrictos entre extractores y modelo;
- historial/versionado del state cuando sea útil.

---

## DataHub

Repositorio:

- https://github.com/datahub-project/datahub

DataHub utiliza una abstracción central denominada `Metadata Change Proposal`: los distintos conectores no escriben directamente en el almacenamiento final; emiten una propuesta normalizada de cambio que el sistema aplica posteriormente.

Es conceptualmente muy parecido a nuestro `Candidate`.

### Idea aprovechable

Mantener `Candidate` como **contrato lógico**, pero no obligatoriamente como fichero persistente.

```text
source adapter
    ↓
Candidate / Change Proposal
    ↓
shared validation + reconciliation
    ↓
canonical data
```

El valor está en el contrato, no en que exista un JSON individual en `inbox/`.

---

## Event Discovery

Repositorio:

- https://github.com/epithe/event-discovery

Proyecto pequeño pero muy relevante por su uso pragmático de IA para eventos.

Pipeline:

```text
sources
  ↓
RawEvent[]
  ↓
collapse recurring
  ↓
dedup hashes
  ↓
hard exclusions
  ↓
cheap prefilters
  ↓
Claude scoring (batch)
```

Su README hace explícita una decisión fundamental:

> el paso de IA es caro; todo lo que pueda reducir el número de eventos antes de llegar a Claude debe ocurrir primero.

Cada source devuelve `list[RawEvent]` y no conoce el resto del pipeline. Un fallo de una source no rompe las otras.

Utiliza hashes basados en título + fecha + lugar para deduplicación sencilla.

### Ideas aprovechables

- **IA al final del funnel, no al principio**;
- dedup y filtros baratos antes de llamadas al modelo;
- batch de eventos en una sola llamada cuando sea apropiado;
- estadísticas por source (`scraped`, `accepted`, etc.);
- fuentes independientes;
- `RawEvent` mínimo común antes de enriquecimiento.

---

## Tokoro

Repositorio:

- https://github.com/robertoranon/tokoro

Tokoro es un agregador de eventos explícitamente LLM-powered y tiene varias ideas interesantes para fuentes difíciles.

### Modos de crawler

Distingue varios modos:

- **direct**: URL de un evento concreto;
- **discover**: página de venue → descubrir URLs de eventos → extraer cada una;
- **festival**: encontrar páginas de programación → extraer muchos eventos en bulk;
- **image**: cartel/imagen → extracción multimodal.

Esto es muy relevante para Clásica Madrid porque nuestras fuentes no tienen todas la misma topología.

### Fetcher escalonado

Tokoro permite elegir:

- fetching ligero;
- Playwright para JS complejo.

La idea general es:

```text
HTTP/simple first
      ↓ si no basta
browser/Playwright
```

No usar un navegador completo por defecto.

### Debug sin publicación

Tiene un modo que permite:

```text
fetch + extract
pero NO normalize/publish
```

y otro que normaliza pero no publica.

Esto sugiere que Clásica Madrid debería permitir inspeccionar claramente cada etapa:

```text
fetch
extract
normalize
reconcile
validate
publish
```

sin obligar a ejecutar todas.

### Job registry

Tokoro permite describir crawls programados mediante YAML (`jobs.yaml`) con URL, modo, fetcher y modelo.

### Ideas aprovechables

- `source.mode = direct | discover | listing | festival | image`;
- estrategia de fetch configurable por source;
- bulk extraction cuando una página contiene muchos eventos;
- browser solamente como fallback;
- modo dry-run/debug;
- configuración de jobs separada del código;
- abstracción del proveedor/modelo de IA para no acoplar el pipeline a uno concreto.

---

## AIeGator

Repositorio:

- https://github.com/FlowBondTech/egator

Agregador de eventos multi-source con adapters para APIs y schema.org.

Su deduplicación combina:

1. blocking por ciudad + fecha;
2. embeddings del contenido;
3. clustering DBSCAN;
4. verificación mediante LLM para clusters dudosos.

### Idea aprovechable

La secuencia es más importante que las tecnologías concretas:

```text
blocking determinista barato
       ↓
similarity solamente dentro del bloque
       ↓
LLM solamente para casos fronterizos
```

No necesitamos embeddings/DBSCAN inicialmente, pero este patrón puede ser útil si el volumen y la ambigüedad crecen.

---

## changedetection.io

Repositorio:

- https://github.com/dgtlmoon/changedetection.io

Aunque no es un sistema de ingestión, aporta un concepto muy útil: **antes de interpretar una página, decidir si el contenido relevante ha cambiado**.

Permite:

- HTTP ligero o browser según la página;
- CSS/XPath/JSONPath para aislar la parte relevante;
- hashes/diffs;
- distintas frecuencias por watch;
- acciones solamente cuando se detecta cambio;
- PDF/change detection;
- IA opcional sobre el diff, no necesariamente sobre la página completa.

### Ideas aprovechables

- frecuencia por source, no cron global idéntico para todas;
- hash de contenido relevante;
- selector configurable que elimina navegación/footer/ruido;
- no ejecutar extracción/IA si el sentinel no ha cambiado;
- cuando cambia, almacenar el diff o snapshot para debugging;
- para algunas fuentes, pasar al LLM **el diff relevante** puede ser mucho más barato que pasar toda la página.

---

## Prefect y Dagster

Repositorios:

- https://github.com/PrefectHQ/prefect
- https://github.com/dagster-io/dagster

Son orquestadores completos y serían infraestructura excesiva para la fase actual de Clásica Madrid.

No obstante, aportan conceptos útiles.

### Prefect

- tareas pequeñas;
- retries;
- timeouts;
- caching;
- concurrencia;
- estado de cada task;
- observabilidad por ejecución.

### Dagster

- assets y dependencias explícitas;
- checks de calidad;
- freshness checks;
- particiones por tiempo/source;
- impedir downstream processing si falla un check bloqueante.

### Ideas aprovechables sin adoptar los frameworks

Cada source run debería producir un resultado observable:

```text
success / failed / unchanged / partial / needs-review
```

con métricas y timestamps.

Y deberíamos poder detectar:

> "esta source normalmente se actualiza diariamente pero lleva 5 días sin una ejecución válida".

No necesitamos desplegar Prefect/Dagster para conseguirlo; un JSON de state + logs de GitHub Actions pueden ser suficientes inicialmente.

---

# 3. Patrones comunes que aparecen una y otra vez

## 3.1 Source Adapter como frontera estable

La mayoría de sistemas maduros convergen hacia:

```text
una implementación/configuración por fuente
                ↓
         formato común
```

Para Clásica Madrid:

```text
SourceAdapter.fetch/extract()
        ↓
RawEvent[]
```

El adapter NO debería:

- deduplicar contra todo el catálogo;
- generar directamente todos los ficheros canónicos;
- decidir auto-merge;
- modificar la UI.

---

## 3.2 RawEvent pequeño y tolerante

Antes del `Candidate` completo conviene considerar un modelo `RawEvent` que represente exactamente lo extraído de una source.

Ejemplo conceptual:

```ts
interface RawEvent {
  sourceKey: string;
  sourceUrl: string;
  externalId?: string;
  title?: string;
  date?: string;
  time?: string;
  venueText?: string;
  organizerText?: string;
  description?: string;
  performersText?: string[];
  programText?: string;
  fetchedAt: string;
}
```

Características:

- conserva wording de la source;
- no obliga a resolver IDs canónicos;
- puede estar incompleto;
- sirve para debugging;
- permite que todos los adapters tengan una interfaz simple.

Después:

```text
RawEvent
  ↓
normalization/entity resolution
  ↓
Candidate
```

---

## 3.3 Estado por source

El sistema debería saber, como mínimo:

```text
lastAttemptAt
lastSuccessAt
lastChangedAt
lastContentHash
lastCursor
lastEventCount
adapterVersion
status
```

No todos los campos se aplicarán a todas las fuentes.

El state permite:

- incremental sync;
- detectar sources stale;
- debugging;
- saber si una ejecución produjo cambios;
- evitar repetir trabajo;
- resetear/reprocesar conscientemente.

---

## 3.4 Fetch barato antes de fetch caro

Jerarquía sugerida:

```text
API / ICS / JSON
       ↓
static HTTP HTML
       ↓
structured data / JSON-LD
       ↓
DOM extraction
       ↓
Playwright
       ↓
LLM over cleaned content
       ↓
multimodal / agentic research
```

No todas las etapas son secuenciales; una source puede saltar directamente a una estrategia conocida. La regla es elegir **el mecanismo más barato y determinista que resuelva correctamente la fuente**.

---

## 3.5 Change detection antes de re-extraction

Para cada source estable puede guardarse un fingerprint del input relevante.

```text
fetch sentinel
    ↓
hash igual? ── sí ──► unchanged / stop
    │
    no
    ▼
full extraction
```

El sentinel puede ser:

- ETag/Last-Modified;
- JSON version;
- hash de una API response;
- hash de una sección HTML;
- lista de event URLs;
- fecha de actualización;
- checksum de PDF.

---

## 3.6 Separar discovery de extraction

Muy importante para la larga cola.

```text
Discovery
  "hay algo nuevo aquí"
        ↓
Extraction
  "estos son exactamente los eventos"
```

Un agente puede descubrir una URL nueva sin tener que generar inmediatamente todos los datos canónicos.

Además, si descubre una fuente recurrente, debe proponer incorporarla al source registry.

---

## 3.7 Deterministic funnel antes de IA

Inspirado especialmente por Event Discovery, OpenSanctions y pipelines de dedupe:

```text
raw events
   ↓
obvious invalid / out of scope
   ↓
exact duplicates
   ↓
known aliases
   ↓
blocking
   ↓
cheap fuzzy matching
   ↓
IA para extracción/clasificación/ambiguity
```

Nunca enviar al modelo trabajo que una comparación, hash, lookup o parser puede resolver con mayor certeza y menor coste.

---

## 3.8 Persistir decisiones humanas/de IA confirmadas

Una resolución repetitiva debe convertirse en configuración.

Ejemplos:

```text
venue alias
organizer alias
source-specific spelling
known false duplicate
known same entity
special parser mapping
```

Esto crea una memoria operativa auditable.

---

## 3.9 Diff con el catálogo anterior

Una ejecución no debería producir solamente `newEvents`.

Debería clasificar cambios aproximadamente como:

```text
new
unchanged
updated
missing-from-source
cancelled
ambiguous
```

`missing-from-source` NO equivale automáticamente a `cancelled`.

Puede significar:

- cancelación;
- cambio de URL;
- paginación distinta;
- error del scraper;
- la source ya no devuelve tanto futuro;
- reorganización del sitio.

City Scrapers demuestra el valor de comparar con ejecuciones anteriores; Clásica Madrid debe aplicar una política conservadora según la source.

---

## 3.10 Idempotencia

Ejecutar dos veces el mismo pipeline con el mismo input debería producir el mismo resultado y, preferentemente, un diff vacío la segunda vez.

Esto implica:

- IDs deterministas cuando sea posible;
- upserts/reconciliation;
- content hashes;
- no regenerar IDs aleatorios;
- no reescribir ficheros si su contenido canónico no ha cambiado.

Esto reduce PRs ruidosas y despliegues innecesarios.

---

## 3.11 Observabilidad por source

Cada ejecución debería poder contestar:

```text
¿Cuándo se ejecutó?
¿Funcionó?
¿Cuánto tardó?
¿Cuántas páginas descargó?
¿Cuántos RawEvent produjo?
¿Cuántos Candidate produjo?
¿Cuántos eran nuevos?
¿Cuántos cambiaron?
¿Cuántos se descartaron?
¿Usó IA?
¿Cuántas llamadas/tokens aproximadamente?
¿Hubo warnings?
```

Las métricas por source son especialmente útiles para detectar roturas silenciosas.

Ejemplo:

```text
CNDM normalmente produce 30–60 eventos.
Hoy produce 0.
```

Aunque el scraper no lance excepción, eso debe ser sospechoso.

---

## 3.12 Tests y fixtures por source

Cada adapter debería disponer de una muestra/snapshot pequeño y estable para probar:

```text
input fixture
     ↓
adapter
     ↓
expected RawEvent[]
```

Esto permite detectar rápidamente si un refactor rompe una source y documenta implícitamente cómo funciona.

Para páginas dinámicas pueden guardarse fragmentos HTML/JSON representativos, sin necesidad de hacer llamadas de red durante CI.

---

# 4. Propuesta de arquitectura refinada a partir de la investigación

La investigación refuerza y concreta la dirección de [`ingestion-v2-plan.md`](ingestion-v2-plan.md) (histórico; la arquitectura objetivo vigente está en [`docs/ingestion-v3-plan.md`](../ingestion-v3-plan.md)).

## Capa 1 — Source Registry

Configuración versionada por source.

Conceptualmente:

```yaml
id: cndm
name: Centro Nacional de Difusión Musical
enabled: true
trust: high
schedule: daily
mode: listing
fetcher: http
adapter: cndm
urls:
  - ...
stateKey: cndm
```

Campos potenciales adicionales:

```text
expectedMinEvents
expectedMaxEvents
contentSelector
changeDetection
lookbackDays
lookaheadDays
supportsCancellation
aiPolicy
```

No todos deben implementarse desde el primer día.

---

## Capa 2 — Fetchers compartidos

Interfaces reutilizables:

```text
HttpFetcher
JsonFetcher
IcsFetcher
PlaywrightFetcher
PdfFetcher
```

Responsabilidades comunes:

- timeout;
- retry;
- backoff;
- user agent;
- caching;
- conditional requests cuando sea posible;
- logging;
- response hash;
- snapshot/debug metadata.

---

## Capa 3 — Source Adapters

Dos estilos.

### Declarativos

Para sources sencillas:

```yaml
extract:
  type: jsonld
  selector: Event
```

o:

```yaml
extract:
  type: html
  eventSelector: .event-card
  title: .title
  date: time@datetime
  url: a@href
```

### Código específico

Para sources difíciles:

```ts
class CndmAdapter implements SourceAdapter {
  extract(input): RawEvent[] { ... }
}
```

---

## Capa 4 — RawEvent

Output uniforme de todos los adapters.

RawEvent debe conservar:

- source key;
- URL concreta;
- external ID cuando exista;
- valores source-facing;
- fetchedAt;
- opcionalmente evidence/snippets mínimos útiles para debugging.

---

## Capa 5 — Normalization

Aplicar primero conocimiento determinista:

```text
known venue IDs
aliases
organizer aliases
URL mappings
series mappings
source-specific lookups
normalización básica de texto/fecha
```

Solo después utilizar IA cuando falte clasificación o haya ambigüedad.

---

## Capa 6 — Reconciliation / dedupe

Orden recomendado:

1. external ID exacto;
2. source URL exacta;
3. IDs conocidos;
4. venue + fecha + hora + título normalizado;
5. reglas/fuzzy matching;
6. blocking;
7. IA solamente en casos dudosos.

Las decisiones ambiguas deberían poder persistirse como judgement para no reaparecer indefinidamente.

---

## Capa 7 — Candidate[]

`Candidate` sigue siendo el contrato de propuesta de cambio.

Puede existir:

- en memoria durante automatización;
- como JSON en `ingestion/inbox/` durante trabajos manuales/debugging;
- como artifact de CI si interesa inspeccionarlo.

No debe exigirse un commit por candidate.

---

## Capa 8 — Batch reconciliation con data/**

Entrada:

```text
current canonical catalog
        +
Candidate[]
```

Salida:

```text
ChangeSet
```

Ejemplo conceptual:

```ts
interface ChangeSet {
  newEvents: Event[];
  updatedEvents: Event[];
  unchangedEvents: string[];
  suspectedMissing: string[];
  conflicts: Conflict[];
  newEntities: ...;
}
```

Solo si el ChangeSet supera los checks se materializa en `data/**`.

---

## Capa 9 — Quality gates

Checks estructurales:

- Zod;
- references;
- duplicates;
- ID uniqueness;
- URLs;
- dates;
- catalogue invariants.

Checks operativos:

- source produjo 0 eventos inesperadamente;
- caída extrema respecto a ejecución anterior;
- aumento extremo;
- cambio masivo de URLs;
- demasiados conflicts;
- extracción con IA devolvió muchos campos vacíos;
- source de alta confianza cambió de estructura.

---

## Capa 10 — PR

La PR debería resumir datos, no solamente mostrar 200 blobs JSON.

Ejemplo:

```text
Ingestion run 2026-09-14

Sources: 18
Successful: 17
Failed: 1
Unchanged sources: 10

Events:
+ 14 new
~ 6 updated
- 1 cancellation confirmed
? 3 need review

AI:
2 source pages required AI extraction
1 duplicate required AI review
```

El diff de Git sigue siendo la evidencia final, pero el resumen facilita enormemente la revisión.

---

# 5. Workflow periódico recomendado

## Ruta A — fuentes conocidas

Ejecutar frecuentemente:

```text
for each enabled source
       ↓
change check / incremental fetch
       ↓
unchanged? → stop source
       ↓
extract RawEvent[]
       ↓
normalize
       ↓
reconcile
```

Después se combina todo en un batch común antes de generar el ChangeSet.

Una source fallida no debe bloquear la extracción de las demás, aunque sí puede impedir auto-merge dependiendo de su importancia.

---

## Ruta B — discovery de larga cola

Con menor frecuencia:

```text
catálogo actual
+ source registry
+ ventana temporal
        ↓
agentic search
        ↓
URLs/event leads nuevos
        ↓
cheap duplicate screening
        ↓
verification/extraction only for novel leads
```

Dos outputs distintos:

```text
new event candidates
new recurring source candidates
```

La segunda categoría es estratégicamente muy importante.

---

# 6. Política sugerida de IA

## IA no necesaria

- parsing JSON/ICS;
- fechas estructuradas;
- URLs;
- hashes;
- exact duplicate detection;
- aliases conocidos;
- source IDs;
- schema validation;
- checks de rango;
- eventos ya vistos sin cambios.

## IA potencialmente útil

- extracción de prosa/HTML irregular;
- PDFs/carteles;
- clasificación musical;
- identificación de performers/composers cuando el texto es complejo;
- descubrimiento de fuentes;
- dedupe ambiguo;
- interpretación de cambios no estructurados.

## Regla económica

Antes de cada llamada al modelo debería poder contestarse:

> ¿Existe una operación determinista barata que reduzca o elimine esta llamada?

Cuando se use IA, preferir:

- contenido limpiado en vez de HTML completo;
- diff en vez de página completa si aplica;
- múltiples eventos por llamada cuando sea seguro;
- salida JSON schema constrained;
- modelo barato para clasificación sencilla;
- modelo potente solo para casos realmente ambiguos.

---

# 7. Ideas que NO parecen necesarias ahora

La investigación también ayuda a evitar sobrearquitectura.

## No introducir Airbyte/Meltano como plataforma

Sus patrones son buenos, pero conectar webs culturales personalizadas no encaja especialmente bien en un ELT generalista y añadiría una nueva plataforma que operar.

## No introducir Prefect/Dagster todavía

GitHub Actions + scripts TypeScript son suficientes mientras el volumen sea manejable.

Reconsiderar un orquestador únicamente si aparecen problemas reales de:

- cientos/miles de jobs;
- dependencias complejas;
- backfills frecuentes;
- necesidad fuerte de UI operacional;
- ejecución distribuida.

## No introducir Redis/colas

Los jobs pueden seguir siendo batch y scheduled.

## No introducir embeddings/vector DB para dedupe de entrada

Primero explotar:

- external IDs;
- URLs;
- exact matching;
- aliases;
- blocking;
- fuzzy strings sencillos.

La deduplicación semántica avanzada puede añadirse cuando tengamos ejemplos reales que demuestren que hace falta.

## No introducir una base de datos de producción

Nada de lo investigado cambia la conclusión actual: Git + JSON puede seguir siendo el catálogo canónico mientras el volumen sea razonable.

Un pequeño state/cache operativo no equivale a migrar la aplicación pública a una base de datos.

---

# 8. Ideas concretas que merece la pena prototipar primero

Ordenadas aproximadamente por valor/coste.

## 1. Auditoría del lote de septiembre

Medir sources/domains y saber qué 10–20 fuentes aportan la mayor parte de eventos.

## 2. `RawEvent`

Crear un contrato mínimo común para extractores.

## 3. Source Registry

Cada source con metadata, estrategia, frecuencia y adapter.

## 4. Primera interfaz `SourceAdapter`

```text
extract(context) → RawEvent[]
```

## 5. Dos o tres fetchers compartidos

- HTTP/JSON;
- HTML;
- Playwright fallback.

## 6. State por source

Aunque inicialmente sea simplemente:

```text
ingestion/state/<source>.json
```

## 7. Content hash/change detection

Evitar parsing/IA cuando la source no ha cambiado.

## 8. Lookups/aliases versionados

Para venue/organizer/source normalization.

## 9. Batch reconciliation

Procesar el conjunto antes de tocar `data/**`.

## 10. Diff de eventos existentes

Detectar updates y posibles desapariciones, no solamente inserts.

## 11. Source health checks

Como mínimo:

```text
status
last success
event count
warnings
```

## 12. PR summary automático

Convertir un diff grande en una revisión humana comprensible.

---

# 9. Un posible árbol de carpetas futuro

Solo como referencia conceptual:

```text
ingestion/
  registry/
    cndm.yml
    teatro-real.yml
    ...

  adapters/
    cndm.ts
    teatro-real.ts
    generic-jsonld.ts
    generic-ics.ts
    generic-html.ts

  fetchers/
    http.ts
    playwright.ts
    pdf.ts

  pipeline/
    raw-event.ts
    normalize.ts
    reconcile.ts
    deduplicate.ts
    validate.ts
    changeset.ts

  lookups/
    venues.yml
    organizers.yml
    sources.yml

  state/
    # runtime/local/artifact; decidir si se versiona

  inbox/
    # manual/debug path, no ruta obligatoria

  fixtures/
    cndm/
    teatro-real/
```

La estructura final debe mantenerse pequeña. No crear todos estos módulos hasta que exista código real que los necesite.

---

# 10. Hipótesis clave a validar con septiembre

Antes de cerrar la arquitectura v2 conviene responder empíricamente:

1. ¿Qué porcentaje de eventos procede de las 10 principales sources?
2. ¿Qué porcentaje puede extraerse sin IA?
3. ¿Cuántas sources ofrecen JSON-LD, APIs internas, ICS o HTML suficientemente estable?
4. ¿Cuántos eventos son verdaderos duplicados cross-source?
5. ¿Con qué frecuencia una misma source publica cambios sobre eventos existentes?
6. ¿Qué tipos de eventos desaparecen de la fuente antes de celebrarse?
7. ¿Cuántas decisiones de entity resolution aparecen repetidamente?
8. ¿Qué porcentaje de larga cola aporta realmente valor diferencial al catálogo?
9. ¿Cuánto cuesta en tokens/tiempo la IA por cada evento que solo ella consigue resolver?
10. ¿Qué sources justifican browser automation y cuáles funcionan con HTTP simple?

Estas respuestas deben determinar la implementación, no una preferencia previa por una herramienta concreta.

---

# 11. Conclusión

La conclusión más fuerte de la investigación es que los sistemas maduros **no vuelven a resolver todo el problema desde cero en cada ejecución**.

Acumulan conocimiento operativo:

- qué fuentes existen;
- cómo se leen;
- cuál fue su último estado;
- cómo se normalizan sus valores;
- qué entidades son equivalentes;
- qué registros ya se vieron;
- qué cambió;
- qué excepciones ya fueron resueltas.

El workflow objetivo de Clásica Madrid debería evolucionar hacia:

```text
known sources
   ↓
cheap change detection / incremental fetch
   ↓
source-specific extraction
   ↓
RawEvent[]
   ↓
deterministic normalization
   ↓
selective AI fallback
   ↓
batch reconciliation + dedupe
   ↓
quality gates
   ↓
ChangeSet
   ↓
PR
```

complementado por:

```text
periodic AI discovery
   ↓
missing events + new sources
   ↓
source registry grows
   ↓
future AI dependency decreases
```

La mejor métrica de madurez del pipeline no será solamente cuántos eventos consigue encontrar, sino **cuánto conocimiento reutilizable incorpora cada vez que encuentra algo nuevo**.
