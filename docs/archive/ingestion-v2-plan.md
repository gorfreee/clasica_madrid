# Ingestión v2 — plan de evolución

> **Documentación histórica.** Este documento **no** representa la arquitectura vigente y **no** debe usarse como especificación de implementación.
>
> La referencia actual para la evolución de la ingestión es [`docs/ingestion-v3-plan.md`](../ingestion-v3-plan.md). El estado operativo de lo que hay implementado hoy está en [`docs/ingestion.md`](../ingestion.md).
>
> Consérvese como contexto de decisiones anteriores. Sólo úsalo como requisito si una tarea pide explícitamente investigar ese historial.

> Estado original: **propuesta de diseño**. Este documento describe la dirección recomendada para evolucionar la ingestión de Clásica Madrid a partir de lo aprendido con la primera carga real de eventos. No sustituye todavía a `docs/ingestion.md` ni implica que el flujo v1 deje de ser válido mientras no se implemente la v2.

## 1. Contexto

La primera carga real de eventos se ha utilizado como prueba práctica del modelo de ingestión actual.

El enfoque seguido fue deliberadamente manual: un agente de IA con acceso a la repo realizó una búsqueda amplia de eventos de música clásica de Madrid para un mes completo, verificó fuentes, modeló cada evento según los schemas de la aplicación y generó numerosos `candidate JSON` en `ingestion/inbox/`.

La prueba ha sido útil porque ha demostrado que:

- el modelo de datos puede representar eventos reales y heterogéneos;
- el concepto de `Candidate` es útil como frontera entre información descubierta y datos canónicos;
- las validaciones deterministas son una buena barrera antes de publicar;
- GitHub sigue siendo una fuente de verdad adecuada para el volumen esperado del proyecto;
- la larga cola de eventos pequeños requiere mecanismos de descubrimiento más amplios que las fuentes institucionales conocidas.

Pero también ha revelado que el proceso no debe convertirse en el mecanismo recurrente de mantenimiento del catálogo.

Un agente generalista ha tenido que hacer simultáneamente:

1. descubrimiento abierto en Internet;
2. navegación por decenas de fuentes;
3. verificación de cada evento;
4. extracción de campos;
5. clasificación musical;
6. generación de IDs;
7. resolución de venues, organizers, series y sources;
8. deduplicación;
9. creación de numerosos ficheros JSON;
10. escritura y commit de todo el lote.

Este flujo consume mucho tiempo y capacidad de agente, repite trabajo ya conocido y escala mal si se pretende repetir cada semana o cada mes.

La conclusión principal es que **la IA no debe ser el motor principal de ingestión rutinaria**. Debe utilizarse donde aporta valor diferencial: descubrimiento, extracción ambigua, clasificación y resolución de excepciones.

---

## 2. Objetivo de la v2

Diseñar una ingestión que pueda mantener una agenda amplia y fiable con el menor coste operativo posible, reutilizando conocimiento acumulado y reservando los agentes de IA para los casos que realmente lo necesiten.

La v2 debe perseguir cinco objetivos principales:

1. **Automatizar las fuentes recurrentes conocidas.**
2. **Evitar redescubrir y reinterpretar las mismas webs en cada ejecución.**
3. **Procesar eventos en batch y como un conjunto, no como una colección de operaciones aisladas.**
4. **Mantener un mecanismo de descubrimiento abierto para cubrir la larga cola.**
5. **Hacer que la cobertura determinista aumente con el tiempo y que la dependencia de IA disminuya.**

El resultado deseado no es eliminar la IA, sino utilizarla de forma selectiva y sostenible.

---

## 3. Principios de diseño

### 3.1 Determinista primero

Siempre que una fuente conocida ofrezca una forma razonablemente estable de obtener datos mediante:

- JSON;
- JSON-LD / `schema.org/Event`;
- ICS;
- feeds;
- APIs públicas o endpoints utilizados por la propia web;
- HTML estructurado;
- páginas con markup estable;

se debe preferir un extractor determinista frente a pedir a un LLM que vuelva a interpretar la fuente desde cero.

### 3.2 La IA como fallback y herramienta de descubrimiento

La IA se reserva especialmente para:

- descubrir nuevas fuentes;
- encontrar eventos no cubiertos por las fuentes conocidas;
- interpretar HTML o texto ambiguo;
- extraer información de PDFs, carteles o páginas poco estructuradas;
- clasificar `eras`, `formats` o `kind` cuando no sea trivial;
- resolver posibles duplicados ambiguos;
- resolver entidades difíciles de normalizar.

### 3.3 GitHub sigue siendo la fuente de verdad del catálogo

No hay evidencia actual que justifique introducir una base de datos de producción.

Los datos publicados deben seguir viviendo en:

```text
data/events/
data/venues/
data/organizers/
data/series/
data/sources/
```

El problema detectado está en **cómo se generan y mantienen esos datos**, no en el uso de Git y JSON como almacenamiento canónico.

### 3.4 Publicación separada de extracción

Un extractor o agente puede proponer datos, pero la entrada a producción debe seguir pasando por:

- schema válido;
- referencias válidas;
- deduplicación;
- reglas de dominio;
- tests;
- build;
- PR / CI.

### 3.5 Aprender de cada descubrimiento

Cuando una búsqueda abierta encuentra una nueva fuente recurrente útil, el resultado no debería ser solamente añadir los eventos encontrados.

Debe evaluarse si esa fuente puede pasar a formar parte del registro de fuentes conocidas para futuras ejecuciones.

La ingestión debe hacerse progresivamente más eficiente.

---

## 4. Arquitectura objetivo

```text
                    ┌─────────────────────────────┐
                    │   REGISTRO DE FUENTES       │
                    │ conocidas y recurrentes     │
                    └──────────────┬──────────────┘
                                   │
                         extractores específicos
                                   │
                                   ▼
                         ┌──────────────────┐
                         │  eventos raw     │
                         └────────┬─────────┘
                                  │
                   ┌──────────────┴───────────────┐
                   │                              │
          normalización determinista      IA puntual / fallback
                   │                              │
                   └──────────────┬───────────────┘
                                  ▼
                            Candidate[]
                                  │
                         normalización global
                                  │
                           deduplicación
                                  │
                         validación del lote
                                  │
                                  ▼
                              data/**
                                  │
                                  ▼
                                 PR
                                  │
                               CI / checks
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                    auto-merge        revisión humana


              PROCESO COMPLEMENTARIO DE DESCUBRIMIENTO

        búsqueda abierta con IA / agentes / otras fuentes
                          │
             ┌────────────┴─────────────┐
             ▼                          ▼
       nuevos eventos             nuevas fuentes
             │                          │
             ▼                          ▼
        Candidate[]             registro de fuentes
```

---

## 5. Registro de fuentes de ingestión

La v2 debería introducir un **registro explícito de fuentes conocidas**.

Este concepto no debe confundirse con `data/sources/`.

- `data/sources/` representa procedencia editorial del catálogo publicado.
- el nuevo registro describe **cómo descubrir y extraer eventos de una fuente recurrente**.

Una estructura posible:

```text
ingestion/sources/
  teatro-real.json
  cndm.json
  ocne.json
  fundacion-juan-march.json
  zarzuela.json
  ...
```

Ejemplo conceptual:

```json
{
  "id": "cndm",
  "name": "Centro Nacional de Difusión Musical",
  "discoveryUrls": [
    "https://example.org/programacion"
  ],
  "strategy": "jsonld",
  "trust": "high"
}
```

Otro caso podría requerir:

```json
{
  "id": "fuente-x",
  "name": "Fuente X",
  "discoveryUrls": [
    "https://example.org/agenda"
  ],
  "strategy": "custom",
  "extractor": "fuente-x",
  "trust": "high"
}
```

Y una fuente difícil podría indicar conceptualmente:

```json
{
  "id": "fuente-y",
  "strategy": "ai-assisted",
  "trust": "medium"
}
```

La estructura exacta debe definirse cuando se implemente. Lo importante es conservar de forma versionada el conocimiento de:

- dónde buscar;
- qué mecanismo usar;
- qué extractor corresponde;
- qué confianza tiene la fuente;
- cualquier regla específica relevante.

---

## 6. Tres niveles de extracción

### Nivel A — determinista

Fuente conocida y estructura fiable.

```text
web → extractor → raw event → Candidate
```

Debe ser la opción preferida.

Ejemplos de posibles mecanismos:

- JSON-LD;
- endpoint JSON;
- ICS;
- HTML con selectores estables.

La IA no debe intervenir para extraer datos que el código puede obtener de forma inequívoca.

### Nivel B — extracción asistida por IA

El sistema ya ha localizado una URL concreta y ha obtenido su contenido relevante.

El modelo recibe una entrada acotada y una tarea estructurada, por ejemplo:

> Extrae estos campos utilizando este schema. No inventes información ausente.

Esto es mucho más eficiente que pedir al modelo que investigue todo Internet.

### Nivel C — investigación abierta

Agente con capacidad de búsqueda para:

- eventos alternativos;
- iglesias;
- conservatorios;
- universidades;
- agrupaciones amateurs;
- pequeños festivales;
- redes sociales;
- nuevas fuentes;
- casos de difícil descubrimiento.

Este nivel es necesariamente más caro y debe utilizarse como complemento, no como ruta estándar para todo el catálogo.

---

## 7. `Candidate` sigue siendo útil, pero no necesariamente como artefacto persistente

El `candidateSchema` actual representa una frontera muy útil entre extracción y publicación.

Sin embargo, la v2 no debería asumir que cada `Candidate` necesita necesariamente:

1. convertirse en un fichero individual;
2. escribirse en `ingestion/inbox/`;
3. commitearse;
4. transferirse a otro workspace;
5. promocionarse manualmente uno a uno.

En un pipeline automático, los candidatos pueden ser objetos efímeros:

```text
extractors
   ↓
Candidate[]
   ↓
normalize
   ↓
deduplicate
   ↓
validate
   ↓
promote batch
   ↓
data/**
```

`ingestion/inbox/` puede mantenerse como herramienta útil para:

- importaciones manuales;
- debugging;
- pruebas;
- handoffs puntuales entre agentes;
- candidatos que necesitan inspección humana.

Pero no debería convertirse necesariamente en una cola persistente obligatoria para cada evento rutinario.

La PR ya proporciona una frontera clara entre datos generados y datos publicados.

---

## 8. Ingestión batch

La v1 dispone de una promoción de un candidato individual.

La v2 debería incorporar un flujo batch, conceptualmente:

```bash
npm run ingest:batch
```

El motor debe recibir un conjunto de candidatos y procesarlos globalmente.

### Responsabilidades deseadas

1. cargar el catálogo canónico actual;
2. cargar todos los candidatos del lote;
3. normalizar referencias compartidas;
4. resolver venues comunes;
5. resolver organizers comunes;
6. resolver series comunes;
7. resolver sources comunes;
8. detectar duplicados entre candidatos;
9. detectar duplicados contra `data/**`;
10. construir en memoria el catálogo resultante;
11. ejecutar todas las validaciones deterministas;
12. escribir sólo cuando el resultado completo sea válido.

Idealmente el proceso debe ser **atómico**:

> o el lote produce un catálogo coherente, o no se escribe un resultado parcial.

Esto evita que el orden de promoción cree estados intermedios o conflictos artificiales entre candidatos del mismo lote.

---

## 9. Normalización y deduplicación como conocimiento acumulado

La resolución de entidades no debe depender de que cada agente vuelva a razonar desde cero.

El sistema debería poder acumular aliases o mecanismos equivalentes para reconocer formas distintas de una misma entidad.

Ejemplos conceptuales:

```text
Auditorio Nacional
Auditorio Nacional de Música
```

```text
OCNE
Orquesta y Coro Nacionales de España
```

La estrategia debería combinar, en orden aproximado:

1. IDs ya conocidos;
2. aliases explícitos;
3. nombres normalizados;
4. URLs oficiales compartidas;
5. coincidencias deterministas fuertes;
6. IA o revisión humana únicamente cuando quede ambigüedad.

La IA puede ayudar a resolver un caso difícil, pero la decisión resuelta debería poder convertirse posteriormente en conocimiento reutilizable.

---

## 10. Ingestión incremental, no por meses aislados

La operación normal no debería consistir en ejecutar repetidamente:

> busca todos los conciertos de octubre

> busca todos los conciertos de noviembre

El sistema debería mantener una **ventana temporal móvil**, por ejemplo los próximos 90 días.

```text
HOY ───────────────────────────────────► +90 días
```

Las fuentes conocidas se revisan periódicamente para detectar:

- eventos nuevos;
- cambios de fecha u hora;
- cambios de programa;
- nuevas funciones;
- cancelaciones;
- eventos que desaparecen o cambian de URL.

El pipeline debe pensar en términos de **sincronización y actualización**, no solamente de inserción inicial.

---

## 11. Descubrimiento de larga cola

La extracción de fuentes conocidas nunca será suficiente para cumplir la aspiración de exhaustividad de Clásica Madrid.

Debe mantenerse una búsqueda abierta periódica centrada especialmente en:

- iglesias;
- parroquias y monasterios;
- conservatorios;
- escuelas de música;
- universidades;
- colegios mayores;
- centros culturales municipales;
- fundaciones pequeñas;
- asociaciones;
- agrupaciones amateurs o semiprofesionales;
- recitales puntuales;
- festivales pequeños;
- eventos gratuitos;
- plataformas de eventos;
- redes sociales;
- webs de intérpretes y agrupaciones.

La pregunta de esa búsqueda debe evolucionar.

En lugar de:

> Busca todos los eventos de música clásica de Madrid.

la tarea debería ser aproximadamente:

> Busca eventos de música clásica dentro de nuestra ventana temporal que todavía no estén cubiertos por el catálogo ni por las fuentes conocidas, con especial atención a la larga cola y a nuevas fuentes recurrentes.

El objetivo pasa de reconstruir la agenda entera a **detectar huecos**.

---

## 12. Descubrir fuentes es tan importante como descubrir eventos

Cada vez que la búsqueda abierta encuentre un evento debe preguntarse:

> ¿De dónde proviene y puede esta fuente reutilizarse?

Si se descubre, por ejemplo, un ciclo recurrente publicado siempre en una misma web, esa web puede incorporarse al registro de fuentes.

Esto genera un ciclo virtuoso:

```text
búsqueda IA
   ↓
nueva fuente
   ↓
registro
   ↓
extractor
   ↓
cobertura automática futura
```

Con el tiempo se espera:

```text
dependencia de IA ↓

cobertura determinista ↑
```

La ingestión debe mejorar estructuralmente cada vez que descubre una fuente relevante.

---

## 13. Confianza y revisión

No todos los cambios deben tratarse igual.

La v2 debería poder distinguir aproximadamente entre:

### Alta confianza

Ejemplos:

- extractor conocido;
- fuente oficial;
- estructura estable;
- evento nuevo inequívoco;
- sin conflictos de entidad;
- validación completa.

Estos cambios podrían ser candidatos a auto-merge en el futuro.

### Confianza media

Ejemplos:

- fuente oficial pero extracción asistida por IA;
- clasificación ambigua;
- nueva entidad relacionada;
- programa incompleto.

Podrían generar PR que requiera revisión.

### Baja confianza

Ejemplos:

- fuente secundaria;
- posible duplicado;
- identidad del venue dudosa;
- información contradictoria;
- cambio importante respecto al catálogo existente.

Debe requerir revisión humana.

La confianza no sustituye las validaciones deterministas. Es una capa adicional para decidir el nivel de automatización permitido.

---

## 14. Flujo operativo objetivo

### Ejecución frecuente de fuentes conocidas

```text
source registry
      ↓
extractors
      ↓
Candidate[]
      ↓
batch normalize + deduplicate
      ↓
validate
      ↓
branch / PR
      ↓
CI
      ↓
auto-merge o review según confianza
```

### Ejecución periódica de descubrimiento

```text
catálogo + fuentes conocidas
           ↓
       agente IA
           ↓
 ┌─────────┴─────────┐
 ▼                   ▼
eventos nuevos    fuentes nuevas
 ▼                   ▼
Candidate[]       source registry
```

---

## 15. Papel recomendado de Codex / agentes de código

Los agentes de código no deberían utilizarse rutinariamente para volver a introducir manualmente cientos de eventos.

Su uso de mayor valor es construir y mejorar el sistema.

Ejemplos:

> Analiza la web del CNDM y crea un extractor robusto para su programación.

> Analiza cómo publica sus eventos el Teatro Real y añade soporte al sistema de ingestión.

> Implementa normalización batch para sources compartidas.

> Añade detección determinista de eventos repetidos.

Ese trabajo puede consumir capacidad significativa **una vez**, pero después el resultado se ejecuta repetidamente mediante código barato y auditable.

Esto es preferible a gastar esa misma capacidad todos los meses repitiendo navegación y extracción manual.

---

## 16. GitHub Actions como capa de automatización futura

Cuando la ingestión v2 sea suficientemente estable, GitHub Actions puede ejecutar periódicamente las tareas deterministas.

Posible flujo futuro:

```text
scheduled GitHub Action
        ↓
ingest known sources
        ↓
changes?
   │
   ├── no → termina
   │
   └── sí
        ↓
      branch
        ↓
        PR
        ↓
       CI
        ↓
 auto-merge si alta confianza
```

No debe automatizarse esta capa antes de que los extractores, batch ingestion, deduplicación y reglas de confianza hayan demostrado suficiente fiabilidad.

---

## 17. Utilizar la primera carga real como benchmark

Los candidatos obtenidos en la primera búsqueda exhaustiva de septiembre tienen un valor adicional: pueden utilizarse como dataset de referencia para diseñar la v2.

Antes de implementar muchos extractores conviene analizar:

- número total de eventos;
- dominios que aparecen en las citations;
- eventos aportados por cada dominio;
- venues distintos;
- organizers distintos;
- sources distintas;
- proporción `established` / `alternative`;
- proporción de larga cola;
- cuántos eventos podrían haberse obtenido determinísticamente;
- cuántos realmente necesitaban búsqueda abierta o interpretación de IA.

Esta auditoría puede responder una pregunta fundamental:

> ¿Qué conjunto mínimo de fuentes conocidas explica la mayor parte del catálogo?

Es razonable esperar una distribución tipo Pareto, donde un número pequeño de instituciones explique una parte importante de los eventos y la larga cola represente el resto.

La selección de los primeros extractores debe basarse en estos datos y no solamente en intuición.

---

## 18. Plan de implantación recomendado

### Fase 0 — aprovechar la carga actual

- terminar de revisar la primera carga real;
- conservarla como benchmark;
- no repetir todavía el mismo proceso para meses posteriores;
- medir de dónde han salido los eventos.

### Fase 1 — análisis de cobertura

Crear un informe sobre el lote inicial:

- eventos por source/domain;
- eventos por venue;
- established vs alternative;
- free/paid/unknown;
- concentración de eventos en las principales fuentes;
- principales fuentes de larga cola.

Resultado esperado: priorización objetiva de fuentes.

### Fase 2 — núcleo de ingestión v2

Implementar:

- registro de fuentes;
- interfaz común para extractores;
- modelo de `RawEvent` si resulta útil;
- transformación `RawEvent → Candidate`;
- ingestión batch;
- promoción atómica;
- normalización conjunta;
- deduplicación de lote.

### Fase 3 — primeros extractores

Construir primero extractores para las fuentes que aporten mayor cobertura.

No fijar el número de antemano; priorizar por retorno esperado.

El objetivo inicial podría ser cubrir determinísticamente la mayor parte de la programación institucional y recurrente.

### Fase 4 — comparación contra benchmark

Ejecutar los extractores sobre el mismo periodo utilizado por la búsqueda exhaustiva inicial.

Comparar:

```text
eventos encontrados por búsqueda exhaustiva IA
vs.
eventos encontrados por ingestión determinista
```

Medir:

- recall aproximado;
- falsos duplicados;
- campos perdidos;
- fuentes no cubiertas;
- tipos de evento que siguen dependiendo de IA.

### Fase 5 — descubrimiento complementario

Diseñar el proceso periódico de búsqueda abierta para localizar:

- eventos faltantes;
- nuevas fuentes;
- cambios no detectados;
- larga cola.

### Fase 6 — automatización

Solo cuando los pasos anteriores sean fiables:

- GitHub Actions programadas;
- PR automáticas;
- reglas de confianza;
- auto-merge de cambios claramente seguros.

---

## 19. Métricas útiles

La ingestión v2 debería poder medirse.

Métricas recomendadas:

### Cobertura

- eventos futuros totales;
- eventos por fuente;
- eventos por tipo de fuente;
- porcentaje obtenible determinísticamente;
- porcentaje descubierto por IA;
- fuentes nuevas descubiertas por mes.

### Calidad

- candidatos rechazados;
- duplicados detectados;
- conflictos de entidades;
- eventos modificados tras revisión humana;
- errores de fuente;
- eventos cancelados detectados correctamente.

### Eficiencia

- ejecuciones que no generan cambios;
- eventos procesados por extractor;
- páginas que requieren IA;
- llamadas de IA por evento;
- coste o consumo aproximado de IA por ejecución.

Una señal de que la arquitectura mejora sería que el número absoluto de eventos aumente mientras la proporción que necesita investigación IA rutinaria disminuye.

---

## 20. Qué no hacer todavía

La experiencia actual no justifica introducir:

- base de datos de producción;
- backend permanente;
- CMS;
- cola externa;
- microservicios;
- infraestructura de pago;
- arquitectura distribuida compleja.

Tampoco conviene automatizar inmediatamente todos los cambios hasta producción.

Primero hay que conseguir que el pipeline sea fiable y observable.

---

## 21. Decisiones abiertas para la implementación

La v2 deberá concretar varias cuestiones durante su construcción:

1. formato exacto del source registry;
2. interfaz de los extractores;
3. si introducir o no un `RawEvent` intermedio;
4. dónde almacenar aliases de entidades;
5. reglas exactas de deduplicación;
6. comportamiento ante modificaciones de eventos ya existentes;
7. cómo modelar desapariciones y cancelaciones;
8. cómo asignar niveles de confianza;
9. cuándo una extracción asistida por IA puede auto-publicarse;
10. qué papel definitivo mantiene `ingestion/inbox/`;
11. frecuencia de sincronización de cada fuente;
12. frecuencia de la búsqueda abierta de larga cola.

Estas decisiones deben resolverse a partir de casos reales y pruebas, evitando ampliar prematuramente la infraestructura.

---

## 22. Criterio de éxito

La ingestión v2 será un éxito cuando el mantenimiento habitual de Clásica Madrid se parezca más a:

```text
actualizar automáticamente fuentes conocidas
            +
buscar periódicamente lo que falta
```

que a:

```text
pedir a un agente que reconstruya toda la agenda desde Internet cada mes
```

El sistema debe acumular conocimiento sobre sus fuentes, reducir trabajo repetitivo y permitir que la IA se concentre precisamente en aquello que hace que Clásica Madrid sea diferente: encontrar eventos difíciles de descubrir sin sacrificar fiabilidad y trazabilidad.
