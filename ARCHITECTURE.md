# Arquitectura de Clásica Madrid

Este documento define la arquitectura técnica base del proyecto. Debe mantenerse estable y cambiar sólo cuando exista una necesidad real demostrada.

Distingue principios duraderos de operación actual. El detalle operativo de la ingestión vive en [`docs/ingestion.md`](docs/ingestion.md); la dirección restante, en [`docs/ingestion-v3-plan.md`](docs/ingestion-v3-plan.md).

## Principios

1. **Coste de infraestructura y del pipeline: 0 €**. El proyecto debe funcionar dentro de los planes gratuitos de GitHub y Cloudflare. La IA de ingestión automática sólo puede usar capacidad explícitamente gratuita y debe detenerse al agotarla; las herramientas personales de desarrollo quedan fuera de esta restricción.
2. **GitHub es la fuente de verdad**. Los datos publicados viven en ficheros versionados dentro del repositorio, no en una base de datos en producción.
3. **Sitio estático por defecto**. La web se genera en build time y se sirve como HTML/CSS/JS estático.
4. **Rendimiento y usabilidad primero**. La experiencia debe ser excelente en móvil y escritorio, con poco JavaScript, HTML semántico y diseño responsive.
5. **Interfaz desacoplada del dominio**. La presentación debe poder rediseñarse o reemplazarse ampliamente sin modificar los datos canónicos, la ingestión ni la lógica de negocio.
6. **Automatización auditable**. Los agentes de IA y los jobs de ingestión proponen cambios mediante PR; la validación determinista decide si un cambio es estructuralmente válido.
7. **Añadir infraestructura sólo cuando sea necesaria**. No introducir bases de datos, APIs, colas, servidores o servicios externos antes de que exista un problema concreto que los requiera. La infraestructura auxiliar de ingestión que ya existe debe permanecer deliberadamente acotada.

## Stack base

- **Astro + TypeScript estricto** para la web.
- **Tailwind CSS** para estilos.
- JavaScript de cliente mínimo; usar componentes interactivos sólo donde aporten valor real.
- **JSON** versionado en GitHub para los datos canónicos.
- **Zod** para validar esquemas y datos.
- **Pagefind** para búsqueda estática, si resulta suficiente; todavía no está instalado. La agenda filtra en cliente sobre el HTML generado en build.
- **Cloudflare Pages** para hosting y despliegue estático.
- **GitHub Actions** para la CI del sitio y para la ingestión automatizada.
- Un **fetch relay** de Cloudflare, GET y autenticado, como infraestructura auxiliar de ingestión — no como backend de la web. El detalle está en `infra/fetch-relay/`.
- **Vitest** para lógica y validadores.
- **Playwright** (Chromium) para unos pocos smoke tests de la agenda y la ficha de evento. No es una suite de regresión visual ni un framework de testing de UI.

No usar una base de datos, backend, SSR, API propia, CMS, sistema de autenticación ni servicios de búsqueda externos para servir la agenda pública.

## Separación entre interfaz y dominio

La interfaz es una capa reemplazable. Debe ser posible experimentar con diseños, componentes, librerías o implementaciones generadas por distintos modelos de IA sin afectar al núcleo del proyecto.

La arquitectura debe mantener separadas, como mínimo, estas capas:

```text
datos canónicos + esquemas
          ↓
lógica de dominio / consultas
          ↓
modelos de presentación
          ↓
componentes y estilos de interfaz
```

Reglas:

- los componentes visuales no deben contener lógica de ingestión, normalización o validación de datos;
- la UI no debe depender directamente de la estructura física de los ficheros del repositorio;
- las páginas y componentes deben consumir contratos o modelos de presentación estables;
- los cambios puramente visuales no deben exigir modificar esquemas ni datos;
- la lógica reutilizable de fechas, filtros, búsqueda, agrupaciones y transformación de datos debe vivir fuera de los componentes visuales;
- evitar acoplar el dominio a Tailwind, Astro o a una librería concreta de componentes.

El objetivo es que una futura sustitución completa del diseño afecte principalmente a la capa de presentación y no obligue a reconstruir el resto del sistema.

Los filtros de la agenda se aplican en el navegador. `src/lib/presentation/agenda-client.ts` localiza el formulario, la lista y el índice serializado con un conjunto pequeño de atributos `data-*` e `#agenda-filter-data`. Eso es un contrato interno de la UI, no un design system: un rediseño puede cambiar markup, clases y estilos, pero no debe eliminar esos selectores mientras el filtrado en cliente siga existiendo. Los smoke tests de `e2e/` cubren ese recorrido.

## Datos

El repositorio contiene tanto código como datos canónicos bajo `data/`. Las entidades y campos están en [`docs/data-model.md`](docs/data-model.md); el contrato ejecutable es `src/lib/schemas`.

Todo dato publicado debe:

- cumplir un esquema explícito y versionado;
- tener identificadores y slugs estables (un slug publicado no se renombra);
- conservar la fuente original y la fecha de comprobación cuando sea posible;
- poder validarse de forma determinista;
- evitar duplicados y referencias rotas.

Los eventos pasados se conservan en el repositorio para disponer de histórico y permitir futuras estadísticas. La agenda pública está orientada a presente y futuro; cada evento canónico conserva una página pública estable `/eventos/{slug}` aunque todas sus representaciones hayan pasado. Cada lugar publicado conserva una página `/lugares/{slug}` aunque ya no tenga conciertos próximos. El índice de lugares lista los lugares principales publicados: primero los que tienen programación futura, después el resto.

Una vez publicado un evento o un lugar, su `slug` es permanente. El identificador (`id`) tampoco cambia. No se renombra un slug ya publicado. Si hay que consolidar dos eventos publicados que son el mismo concierto, el canónico conserva su `id`/`slug` y el slug retirado puede quedar como alias histórico explícito que resuelve a esa ficha.

## Build y publicación

El flujo de publicación de la web es:

```text
GitHub (código + datos)
        ↓
validación + tests
        ↓
Astro build
        ↓
Cloudflare Pages
```

El navegador no debe consultar una base de datos para mostrar la agenda. Los filtros, búsquedas e índices necesarios deben generarse durante el build o resolverse en cliente sobre artefactos estáticos pequeños.

La UI calcula en build etiquetas y estados que dependen del reloj (`Hoy`, `Mañana`, `Fin de semana`, placeholder de hoy, `isPast`, próximos conciertos de lugares). El cliente sólo oculta representaciones ya pasadas; no reconstruye esa semántica. Cloudflare Pages reconstruye el sitio en cada push a `main`. Además, un Cron Worker de Cloudflare dispara diariamente un Deploy Hook poco después de medianoche `Europe/Madrid` para refrescar esa semántica calculada en build.

Los datos fuente del repositorio no tienen por qué copiarse íntegramente al despliegue. El build publicará únicamente los artefactos necesarios para servir la web.

## Descubrimiento e ingestión de eventos

La ingestión está separada de la web pública.

### Arquitectura actual

Lo implementado hoy está en [`docs/ingestion.md`](docs/ingestion.md). El camino legacy de candidatos JSON en disco no es el flujo rutinario.

```text
harvesting / adapters
        ↓
normalización / enrichment
        ↓
reconciliation / publication gate
        ↓
data/**
        ↓
PR → CI → merge condicionado
        ↓
despliegue desde main
```

Discovery v1 es un mecanismo complementario: exporta un contexto estructurado e importa un batch de hechos observados al mismo pipeline. No hay búsqueda web automática dentro de esta repo.

Siempre que sea posible, las fuentes conocidas se procesan mediante mecanismos deterministas (feeds, JSON, ICS, HTML estructurado, etc.). La IA se reserva especialmente para descubrimiento, extracción ambigua, clasificación y resolución de casos difíciles. La arquitectura no debe depender de un proveedor o modelo concreto.

Un agente nunca debe escribir directamente los datos canónicos publicados. Cualquier salida debe someterse al mismo esquema y validaciones deterministas que un cambio manual antes de fusionarse. En el flujo automático, los candidatos existen en memoria; `ingestion/inbox/` no es una cola obligatoria.

### Evolución futura

Siguen fuera del sistema actual, salvo que una tarea pida esa capacidad:

- búsqueda web automática para discovery;
- scheduling propio de discovery;
- aprendizaje o promoción automática de nuevas fuentes a adapters;
- reconciliación fuzzy o con IA residual, si se decide implementarla.

La dirección y las restricciones de esa evolución están en [`docs/ingestion-v3-plan.md`](docs/ingestion-v3-plan.md).

## Publicación automática del catálogo

Las actualizaciones rutinarias y válidas pueden llegar a producción sin intervención humana ordinaria.

Eso ya está implementado: la ingestión abre PRs de `data/**`, la CI del sitio corre sobre esas PRs, y el auto-merge se solicita sólo cuando el health y la configuración lo permiten. El detalle operativo pertenece a [`docs/ingestion.md`](docs/ingestion.md) y al workflow, no a este documento.

La confianza no proviene de saltarse controles. Una PR automática sólo puede fusionarse cuando pasa las comprobaciones deterministas del repositorio (esquema, referencias, duplicados, tests, build) y las reglas de confianza de esa ejecución.

Cuando un caso no pueda resolverse con seguridad, el comportamiento preferido es **degradar o excluir ese dato concreto**, no convertir la revisión humana en un paso ordinario del pipeline ni bloquear el resto de una ejecución sana.

## Rendimiento y experiencia de usuario

La web debe diseñarse mobile-first y funcionar plenamente en escritorio.

Prioridades:

- páginas estáticas y cacheables;
- mínimo JavaScript posible;
- navegación y filtros rápidos;
- URLs compartibles para vistas y filtros importantes;
- accesibilidad y HTML semántico;
- imágenes optimizadas y carga diferida cuando proceda;
- evitar dependencias pesadas sin beneficio demostrable.

## Coste y evolución

Toda decisión de infraestructura debe comprobar primero que funciona con coste recurrente de **0 €** para el proyecto. Las suscripciones personales a herramientas de IA no cuentan como coste de infraestructura.

Si en el futuro el volumen de datos o las funcionalidades requieren una base de datos, backend, almacenamiento adicional u otro servicio, la migración se evaluará entonces. El formato versionado en GitHub seguirá siendo, mientras sea práctico, la fuente auditable de los datos o al menos una representación exportable de ellos.

## Regla de decisión

Ante dos soluciones que resuelvan el mismo problema, escoger la que tenga menos infraestructura, menos coste, menos JavaScript y más facilidad de mantenimiento, siempre que preserve la calidad de los datos y la experiencia de usuario.
