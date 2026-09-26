# Crear un artículo para el blog

Este documento es el playbook para crear un nuevo artículo editorial en Clásica Madrid.

Antes de empezar, lee:

- `PROJECT_CONTEXT.md`
- `docs/blog.md`
- `AGENTS.md`

`docs/blog.md` es la fuente de verdad sobre estructura, frontmatter, imágenes, componentes y publicación. No dupliques aquí esas reglas ni inventes un sistema alternativo.

## Objetivo

Crea el artículo completo, no solo el texto.

El resultado debe tener el nivel de investigación, escritura y presentación que esperaríamos de una buena revista especializada en música clásica: riguroso, interesante, visualmente cuidado y agradable de leer para alguien que sabe mucho de música y también para quien simplemente siente curiosidad.

No des el trabajo por terminado al acabar un primer borrador. Investiga, escribe, revisa, comprueba y mejora el artículo hasta que esté realmente listo para publicarse.

## Investiga antes de escribir

Busca toda la información relevante y sé exhaustivo.

Consulta primero fuentes primarias y actuales —instituciones, salas, artistas, programas oficiales, archivos, documentación especializada— y amplía con fuentes secundarias de calidad cuando aporten contexto, historia, análisis o una perspectiva interesante.

Cuando el tema tenga relación con conciertos, lugares o intérpretes de Madrid, revisa también el catálogo actual de Clásica Madrid. Enlaza las fichas de eventos y lugares que sean relevantes y aprovecha los componentes editoriales del blog cuando mejoren realmente el artículo.

Contrasta los datos importantes. Si las fuentes discrepan o algo no puede verificarse con suficiente seguridad, no lo presentes como un hecho. No inventes información para completar huecos.

## Escribe como una persona, no como una plantilla

La escritura debe ser amena, inteligente, natural y humana.

No hagas una sucesión mecánica de datos ni un resumen institucional reescrito. Busca una estructura narrativa adecuada al tema, explica por qué las cosas son interesantes y aporta contexto que ayude a escuchar, comprender o descubrir mejor la música.

Evita los tics habituales del texto generado por IA: introducciones genéricas, grandilocuencia vacía, estructuras repetitivas, conclusiones que solo resumen lo anterior, exceso de subtítulos, frases formularias y elogios sin contenido.

Cuando esté disponible, utiliza como referencia o como última pasada editorial una herramienta de humanización como [blader/humanizer](https://github.com/blader/humanizer). Úsala para detectar escritura artificial, no para sacrificar precisión, personalidad ni criterio musical.

El texto final debe sonar escrito específicamente para Clásica Madrid y para ese tema concreto.

## Haz un artículo visual

Usa todas las imágenes que sean útiles para contar bien la historia. El usuario autoriza expresamente a obtener y utilizar las imágenes necesarias para estos artículos.

Prioriza imágenes oficiales, históricas, documentales o especialmente relevantes frente a imágenes decorativas genéricas.

Sigue siempre las reglas de `docs/blog.md`: guarda las imágenes localmente, usa el sistema de assets del proyecto, añade `alt` descriptivos y conserva créditos y enlaces a la fuente cuando existan. No hagas hotlinking.

Las imágenes deben enriquecer la lectura, no convertir el artículo en una descarga innecesariamente pesada. Mantén una buena calidad visual sin usar archivos desproporcionados.

## Integra el artículo con Clásica Madrid

Siempre que tenga sentido:

- enlaza eventos existentes con `/eventos/.../`;
- enlaza lugares con `/lugares/.../`;
- enlaza otros artículos relacionados;
- utiliza `UpcomingEvents`, `RelatedVenue`, `ArticleCTA`, `Figure`, `Gallery`, `Callout`, `Quote` o `YouTubeEmbed` cuando aporten valor.

No fuerces componentes ni enlaces solo porque existan.

El blog es una capa editorial sobre un producto cuyo núcleo sigue siendo la agenda.

## Cuida SEO, accesibilidad y rendimiento

El artículo debe tener un título, descripción, estructura de encabezados y contenido que expliquen claramente de qué trata sin escribir para un algoritmo.

No hagas keyword stuffing ni añadas texto de relleno por SEO.

Comprueba especialmente:

- jerarquía correcta de encabezados;
- enlaces internos útiles;
- textos alternativos;
- créditos;
- imágenes razonablemente optimizadas;
- ausencia de overflow o problemas visuales;
- buena lectura tanto en móvil como en escritorio.

No rediseñes el sistema del blog para resolver necesidades de un único artículo salvo que exista una razón clara.

## Antes de publicar

Trabaja inicialmente con `draft: true`.

Antes de quitar el borrador, relee el artículo entero como editor: elimina repeticiones, comprueba nombres, fechas, obras, compositores, intérpretes, enlaces y créditos y revisa que la apertura y el final tengan sentido.

Ejecuta como mínimo los checks relevantes del repositorio:

```bash
npm run validate
npm run test
npm run check
npm run build
```

Ejecuta también los tests de blog correspondientes cuando proceda y comprueba especialmente el resultado en un viewport móvil y otro de escritorio si el artículo incorpora bastante contenido visual o una estructura poco habitual.

Solo entonces publícalo (`draft: false` o sin `draft`).

## Criterio de terminado

El artículo está terminado cuando la información está suficientemente investigada y contrastada, el texto merece ser leído por sí mismo, las imágenes y enlaces aportan valor, la integración con el catálogo es correcta, no hay problemas técnicos evidentes y el resultado se ve bien tanto en móvil como en escritorio.

El estándar no es «el artículo funciona». El estándar es: **estaríamos orgullosos de publicarlo en Clásica Madrid y podría encajar en una revista de prestigio especializada en música clásica.**
