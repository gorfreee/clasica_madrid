# Arquitectura de Clásica Madrid

Este documento define la arquitectura técnica base del proyecto. Debe mantenerse estable y cambiar sólo cuando exista una necesidad real demostrada.

## Principios

1. **Coste de infraestructura: 0 €**. El proyecto debe funcionar dentro de los planes gratuitos de GitHub y Cloudflare. El coste de las herramientas de IA queda fuera de esta restricción.
2. **GitHub es la fuente de verdad**. Los datos publicados viven en ficheros versionados dentro del repositorio, no en una base de datos en producción.
3. **Sitio estático por defecto**. La web se genera en build time y se sirve como HTML/CSS/JS estático.
4. **Rendimiento y usabilidad primero**. La experiencia debe ser excelente en móvil y escritorio, con poco JavaScript, HTML semántico y diseño responsive.
5. **Interfaz desacoplada del dominio**. La presentación debe poder rediseñarse o reemplazarse ampliamente sin modificar los datos canónicos, la ingestión ni la lógica de negocio.
6. **Automatización auditable**. Los agentes de IA proponen cambios mediante PR; la validación determinista decide si un cambio es estructuralmente válido.
7. **Añadir infraestructura sólo cuando sea necesaria**. No introducir bases de datos, APIs, colas, servidores o servicios externos antes de que exista un problema concreto que los requiera.

## Stack base

- **Astro + TypeScript estricto** para la web.
- **Tailwind CSS** para estilos.
- JavaScript de cliente mínimo; usar componentes interactivos sólo donde aporten valor real.
- **JSON** versionado en GitHub para los datos canónicos.
- **Zod** para validar esquemas y datos.
- **Pagefind** para búsqueda estática, si resulta suficiente; todavía no está instalado. La agenda filtra en cliente sobre el HTML generado en build.
- **Cloudflare Pages** para hosting y despliegue estático.
- **GitHub Actions** para validación, tests, builds y automatizaciones.
- **Vitest** para lógica y validadores; **Playwright** sólo para recorridos críticos de la interfaz.

No usar inicialmente una base de datos, backend, SSR, API propia, CMS, sistema de autenticación ni servicios de búsqueda externos.

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

## Datos

El repositorio contiene tanto código como datos canónicos. Una estructura inicial orientativa:

```text
data/
  events/
  venues/
  sources/
```

Los esquemas exactos podrán evolucionar, pero todo dato publicado debe:

- cumplir un esquema explícito y versionado;
- tener identificadores y slugs estables (un slug publicado no se renombra);
- conservar la fuente original y la fecha de comprobación cuando sea posible;
- poder validarse de forma determinista;
- evitar duplicados y referencias rotas.

Los eventos pasados se conservan en el repositorio para disponer de histórico y permitir futuras estadísticas. La agenda pública está orientada a presente y futuro; cada evento canónico conserva una página pública estable `/eventos/{slug}` aunque todas sus representaciones hayan pasado. Cada lugar publicado conserva una página `/lugares/{slug}` aunque ya no tenga conciertos próximos; el índice de lugares puede listar sólo espacios con agenda vigente.

Una vez publicado un evento o un lugar, su `slug` es permanente. No hay aliases ni redirects históricos todavía: no se renombra un slug ya publicado. El identificador (`id`) tampoco cambia.

## Build y publicación

El flujo de publicación es:

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

Los datos fuente del repositorio no tienen por qué copiarse íntegramente al despliegue. El build publicará únicamente los artefactos necesarios para servir la web.

## Descubrimiento e ingestión de eventos

La ingestión está separada de la web pública.

```text
fuentes conocidas + búsqueda con agentes de IA
                  ↓
           eventos candidatos
                  ↓
       validación determinista
                  ↓
   normalización / deduplicación
                  ↓
                  PR
                  ↓
            merge en GitHub
                  ↓
         despliegue automático
```

Los agentes de IA pueden utilizar ChatGPT, Cursor u otras herramientas disponibles. La arquitectura no debe depender de un proveedor o modelo concreto.

Siempre que sea posible, las fuentes conocidas deben procesarse mediante mecanismos deterministas (feeds, JSON, ICS, HTML estructurado, etc.). La IA se reserva especialmente para descubrimiento, extracción ambigua, clasificación y resolución de casos difíciles.

Un agente nunca debe escribir directamente en producción. Su salida debe convertirse primero en datos candidatos sometidos al mismo esquema y validaciones que cualquier cambio manual.

## PR automáticas

El objetivo es que las actualizaciones fiables puedan llegar a producción sin intervención manual.

Una PR automática sólo podrá autoaprobarse/automergearse cuando pase todas las comprobaciones requeridas, entre ellas:

- esquema válido;
- IDs y referencias válidos;
- ausencia de errores de fechas y campos obligatorios;
- controles de duplicados;
- tests del repositorio;
- build correcto;
- reglas de confianza que se definan para la fuente o el tipo de cambio.

Los cambios ambiguos, fuentes nuevas o casos con baja confianza deben quedar pendientes de revisión humana.

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
