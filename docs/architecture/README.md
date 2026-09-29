# Arquitectura visual

`architecture.json` es la única especificación del grafo. Archify genera el HTML; su exportador genera el SVG; el renderer captura ese mismo SVG para producir el GIF del README. No edites esos tres artefactos a mano.

El diagrama representa el sistema inspeccionado en `meta.repository.revision`. Los enlaces de implementación están anclados a ese commit; los hashes del manifest detectan cambios de la especificación, del renderer, de las herramientas y de los artefactos. Un hash vigente **no** prueba que el producto no haya evolucionado: antes de actualizar hay que volver a inspeccionar el código.

## Explorar

Descarga y abre `architecture.html` en un navegador. GitHub muestra su código, no ejecuta el HTML. El fichero es autocontenido: temas light/dark, navegación, focus, búsqueda, enlaces a código, exportaciones y cuatro vistas guiadas. El contenido del diagrama y las vistas está en español; los controles propios de esta versión de Archify están en inglés. La fuente remota es opcional y hay fallback local.

La versión fijada en `toolchain.json` es Archify `2.17.0-dev.1`, revisión `629155a…`: la versión 3 eliminó las vistas guiadas. No cambies el pin sin revisar esa capacidad y regenerar todos los artefactos. Archify es un proyecto de [tt-a1i](https://github.com/tt-a1i/archify), bajo licencia MIT.

## Regenerar

Requisitos de documentación: Node del proyecto, Git, Chromium y ffmpeg en PATH. No se añade ninguna dependencia al runtime del producto.

```bash
npm ci
npx playwright install chromium
npm run architecture:render
npm run architecture:check
```

El primer render descarga Archify a `.local/architecture-tools/` y fija su revisión. Los siguientes reutilizan ese checkout. Se puede usar una copia existente de **esa misma revisión**:

```bash
ARCHIFY_ROOT=/ruta/al/checkout/archify \
ARCHIFY_CHROME=/ruta/al/chrome \
npm run architecture:render
```

`ARCHIFY_CHROME` permite usar el Chrome del sistema cuando el Chromium de Playwright no esté instalado. Instala ffmpeg con el gestor de paquetes de tu sistema. La generación usa el `playwright-core` de desarrollo ya presente en el repositorio; no modifica la web ni requiere secrets.

El comando verifica el esquema, las referencias al commit, la composición showcase y el HTML en navegador. Exporta el SVG dark de Archify y ajusta su tipografía de forma reproducible según `toolchain.json` para mejorar la lectura en el README; no cambia el grafo ni las coordenadas. El GIF usa esa exportación, con geometría fija, foco luminoso progresivo, paleta optimizada y loop infinito. El HTML conserva ambos temas. El manifest guarda hashes, commit y fecha de generación; Chromium/ffmpeg pueden producir bytes diferentes entre versiones, pero la secuencia, el grafo y los controles siguen siendo reproducibles.

La evidencia de navegador y una preview de ancho completo quedan en `.local/architecture-review/`. Los sidecars transitorios de Archify no se versionan. El manifest es el registro portable de los artefactos publicados.

## Revisar y mantener

Después de cada regeneración inspecciona realmente el HTML, el SVG y varios momentos del GIF: ancho de README (~830 px), escritorio (1440 px), pantalla grande, temas y las cuatro vistas. Comprueba contraste, labels, rutas, clipping y overflow. `architecture:check` sólo verifica integridad y referencias; no reemplaza esa revisión visual.

El check tarda poco y sólo necesita Node + Git. Puede ejecutarse manualmente en una PR. No se conecta a la CI productiva ni al deploy: renderizar Chromium/ffmpeg nunca forma parte de la CI normal.

Usa [UPDATE_PROMPT.md](UPDATE_PROMPT.md) para una actualización posterior. El diagrama agrupa fases del pipeline: quality gates incluye reconciliación y validación del lote; el health de ejecución determina después si se abre PR, draft o se solicita auto-merge. Discovery nunca solicita auto-merge. Los scripts de adquisición, IA y workflows no forman parte del runtime público.

El Cron Worker de rebuild y Email Routing están documentados como configuración externa al repo; no se afirma que su implementación esté versionada aquí. El formulario sí llama a **Email Service**. El catálogo JSON se escribe primero en una rama propuesta y sólo llega al catálogo de `main` tras merge; el sitio público no consulta una base de datos.

Los perímetros distinguen GitHub (Actions y repositorio), Cloudflare (build, Pages y Fetch Relay), navegador y servicios externos. HTTP/Chrome se ejecutan en el runner; el Fetch Relay es un Worker en Cloudflare. El contacto se integra en Pages y el rebuild diario se representa con una flecha de retorno al build de Astro, sin cajas adicionales.
