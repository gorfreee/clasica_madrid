# Rediseño de interfaz — dirección de producto y UX

> Estado: **v0.4 / dirección convergida — lista para implementación**  
> Este documento recoge la dirección acordada para el rediseño público de Clásica Madrid. Define producto, UX, restricciones y carácter visual, pero deja deliberadamente margen al agente de implementación para resolver composición, sistema visual y detalles de interacción con criterio.

## Propósito

Clásica Madrid debe convertirse en una agenda pública de música clásica en Madrid que sea a la vez rápida de recorrer, agradable de usar y suficientemente profunda para explorar un catálogo amplio y heterogéneo.

El rediseño no consiste en aplicar estilos nuevos sobre la interfaz actual. Debe replantear la experiencia pública completa alrededor del catálogo ya existente, manteniendo la arquitectura técnica y los contratos de datos salvo que una necesidad real de UX justifique un cambio deliberado.

## Norte de producto

Clásica Madrid debe aspirar a ser la forma más rápida, clara y agradable de descubrir qué música clásica se puede escuchar en Madrid, sin renunciar a la profundidad de un catálogo exhaustivo y bien estructurado.

La complejidad de los datos debe estar **disponible sin imponerse**. La interfaz debe funcionar tanto para quien quiere responder rápidamente “¿qué hay hoy o este fin de semana?” como para quien quiera buscar por lugar, compositor, intérprete, formato, época, acceso u otros atributos.

La simplicidad debe reducir fricción y ruido, no infantilizar la experiencia ni esconder capacidades útiles.

## Principios

### Agenda primero

La home será esencialmente la agenda. No habrá una portada separada ni una hero extensa antes de llegar a los conciertos.

### Profundidad mediante progressive disclosure

La jerarquía general será:

1. agenda para evaluar rápidamente un evento;
2. ficha de evento para comprenderlo en profundidad;
3. búsqueda, filtros y otras superficies para recorrer el catálogo desde otras perspectivas.

### Densidad útil

La agenda debe ser compacta y muy escaneable, especialmente en móvil. La riqueza del modelo de datos no implica mostrar todos los campos a la vez.

### Datos reales e irregulares

La composición debe funcionar con títulos largos, programas extensos, muchos intérpretes, horas desconocidas, lugares largos, eventos gratuitos o de pago, municipios distintos y registros parcialmente completos.

Un dato ausente debe desaparecer limpiamente salvo cuando la ausencia sea importante para asistir o entender el estado del evento.

### Neutralidad

Programación institucional, pequeños ciclos, iglesias, universidades, agrupaciones amateur y otras fuentes convivirán en la misma agenda. No se establecerá una jerarquía editorial de “eventos principales” y “alternativos”.

### Rendimiento, SEO y accesibilidad

Son restricciones del producto desde el principio, no auditorías posteriores.

## Arquitectura de información

`Agenda` y `Lugares` serán las dos superficies principales iniciales y deben aparecer como navegación global explícita.

La arquitectura debe dejar abierta una futura evolución hacia compositor, intérprete, formato, mapa u otras formas de exploración, pero esas superficies no forman parte del alcance inicial salvo que sean necesarias para una experiencia ya existente.

## Home y cabecera

La home debe empezar con una capa de identidad muy ligera y entrar casi inmediatamente en la agenda.

La estructura conceptual será:

- wordmark tipográfico provisional `Clásica Madrid`;
- navegación global `Agenda` / `Lugares`;
- una frase introductoria corta que explique el propósito sin convertirse en hero;
- búsqueda visible;
- acceso a filtros;
- shortcuts temporales y prácticos;
- comienzo inmediato de la cronología.

En móvil deben permanecer visibles como shortcuts frecuentes:

- `Hoy`;
- `Mañana`;
- `Fin de semana`;
- `Gratis`.

Puede existir también un selector de fecha o mecanismo equivalente para saltar a un día concreto.

No se quiere una gran cabecera sticky. El agente puede probar una barra compacta persistente para navegación o búsqueda si aporta valor real y no roba espacio significativo al contenido.

La composición exacta, tamaños, controles y breakpoints quedan abiertos al diseño.

## Agenda

### Jerarquía de cada entrada

La dirección elegida es **title-first pero no title-only**, con una composición editorial compacta y flexible.

Una entrada debe aspirar a comunicar, en este orden conceptual:

1. hora;
2. título canónico;
3. el mejor contexto humano disponible, normalmente intérprete principal, agrupación o equivalente;
4. lugar, con una importancia relativamente alta y presencia casi constante;
5. como máximo una o dos señales secundarias cuando realmente aporten valor.

El lugar es una dimensión especialmente importante para decidir si asistir a un concierto y debe ser fácil de reconocer en el escaneo de la agenda.

Compositor, época, formato, ciclo u otros metadatos no necesitan una posición reservada. Pueden aparecer de manera oportunista cuando mejoren la comprensión, pero no deben llenar la agenda de chips o líneas secundarias.

El `title` canónico seguirá siendo la referencia estable. La UI no debe fabricar de forma general títulos editoriales sintéticos a partir de compositores, obras o programas irregulares.

Programas largos y listas extensas de intérpretes o compositores deben resumirse elegantemente en la agenda y quedar completos para la ficha de evento.

La fuente original no necesita repetirse como texto en cada entrada del listado.

### Responsive

Móvil y escritorio no tienen por qué usar exactamente la misma representación.

#### Móvil

La hipótesis base es una cronología vertical compacta y muy escaneable. Debe evitarse tanto la tabla horizontal como las grandes cards decorativas que reduzcan demasiado la densidad.

#### Desktop

La dirección base será una **agenda editorial de filas densas**, más flexible que una tabla rígida pero con suficiente estructura para comparar rápidamente hora, título, intérpretes, lugar y señales relevantes.

El agente tiene libertad para resolver grid, alineaciones y composición siempre que mantenga la jerarquía de información y la densidad.

## Navegación temporal

La agenda se recorrerá mediante **scroll cronológico continuo**.

Los días serán agrupadores visuales claros. Los encabezados de día deben ser fuertes pero compactos; pueden usar un tratamiento especial para `Hoy` y, si resulta útil, `Mañana`.

Los cambios de mes deben ser claramente reconocibles mediante separadores editoriales u otro tratamiento equivalente.

La home debe empezar **siempre en hoy**, aunque no haya conciertos ese día. En ese caso puede mostrarse un estado vacío muy ligero para hoy y continuar con el siguiente día con programación.

Los días futuros sin conciertos no deben aparecer como bloques vacíos. Cuando haya huecos, la agenda salta al siguiente día que tenga resultados.

La misma regla se aplica después de búsquedas o filtros: no deben mostrarse encabezados de día sin resultados.

No se introducirá inicialmente agrupación adicional de funciones repetidas o eventos relacionados: cada occurrence aparecerá en su posición cronológica.

No se requiere infinite scroll técnico ni un mecanismo de “cargar más” mientras el volumen actual pueda servirse de forma estática y eficiente.

Los encabezados sticky no son un requisito. El agente puede probarlos si mejoran claramente la orientación sin perjudicar el espacio útil ni la estabilidad visual.

## Búsqueda y filtros

Búsqueda y filtros son capacidades relacionadas pero distintas.

### Búsqueda

Debe ser visible sin dominar la home y debe concebirse como búsqueda sobre el catálogo, no sólo sobre títulos.

La primera implementación debería poder encontrar coincidencias útiles en los campos disponibles, especialmente:

- título;
- intérpretes;
- compositores;
- lugares;
- ciclos u otros textos relevantes.

Compositores e intérpretes se tratarán principalmente como dimensiones buscables, no como listas explícitas de filtros de alta cardinalidad.

No es necesario introducir búsqueda semántica ni infraestructura pesada en esta fase.

### Shortcuts

`Gratis` tendrá tratamiento privilegiado como acceso frecuente, junto con los shortcuts temporales principales.

Los eventos gratuitos pueden recibir una señal compacta dentro del listado, pero la forma visual concreta queda abierta al diseño y no tiene por qué ser un badge literal `Gratis`.

### Filtros avanzados

Los filtros explícitos iniciales deben concentrarse en dimensiones con utilidad clara y cardinalidad manejable, especialmente:

- fecha;
- lugar, preferiblemente mediante un selector buscable;
- formato;
- época;
- acceso;
- tipo o nivel de evento cuando los datos disponibles permitan una distinción útil y fiable.

No deben mostrarse permanentemente todos los controles posibles.

Los filtros activos deben ser reconocibles y debe existir una forma clara de eliminar filtros individuales y limpiar el conjunto.

Las URLs compartibles deben preservarse cuando tenga sentido con la arquitectura actual.

### Diferencia móvil / desktop

La interacción puede diferir de forma deliberada:

- **desktop:** los cambios de filtro pueden aplicarse de forma inmediata y pueden permanecer visibles algunos controles frecuentes adicionales;
- **móvil:** el usuario puede seleccionar varias opciones dentro de una superficie dedicada y confirmar al final, idealmente con una acción tipo `Ver N conciertos` o equivalente.

Drawer, bottom sheet, popover, panel lateral u otra solución concreta queda a criterio del agente, siempre que resulte clara, accesible y ligera.

## Programación institucional y alternativa

Los distintos niveles y tipos de programación conviven en la misma agenda general.

No se quieren etiquetas grandes o repetitivas de `alternativo` ni tratamientos que conviertan automáticamente grandes instituciones en contenido principal y pequeños espacios en secundario.

La naturaleza del evento puede expresarse de forma sutil mediante lugar, contexto, intérpretes, metadatos o señales visuales cuando sea útil. Una segmentación más fuerte puede resolverse mediante filtros.

## Lugares

`Lugares` debe funcionar como una verdadera superficie de descubrimiento, no como un directorio administrativo.

### Índice de lugares

La vista principal debe priorizar los lugares con programación próxima.

Para cada lugar puede mostrar, cuando exista:

- nombre;
- número de conciertos próximos;
- próxima fecha con programación;
- municipio o zona cuando aporte contexto.

El orden principal será por **próxima actividad**, no por volumen de programación ni por importancia institucional. El número de eventos puede mostrarse como información secundaria.

Los lugares sin programación futura no deben mezclarse de entrada con los activos. Debe existir una vía clara —por ejemplo `Ver todos los lugares`— para acceder al catálogo completo.

La búsqueda de lugar puede tener presencia propia si ayuda a manejar un catálogo grande.

No se requieren imágenes para que esta superficie funcione.

### Ficha de lugar

La ficha de lugar debe responder principalmente a:

> “Estoy interesado en este lugar; ¿qué música clásica puedo escuchar aquí?”

Debe poder combinar:

- nombre y localización básica;
- próximos conciertos, usando el mismo lenguaje visual de la agenda;
- enlace oficial cuando exista;
- una acción práctica como `Cómo llegar` si puede resolverse de manera fiable;
- otros datos realmente útiles ya disponibles.

No debe convertirse en una ficha enciclopédica o imitar un producto de mapas.

Una futura vista de mapa sigue abierta, pero no forma parte de esta primera implementación.

## Ficha de evento

La ficha de evento es el lugar natural para desplegar la riqueza que la agenda resume.

### Cabecera

Debe ser principalmente informativa, no una hero decorativa.

Título, fecha, hora y lugar deben entenderse casi inmediatamente. El acceso o precio debe tener presencia suficiente cuando sea relevante.

Los estados que afectan a la asistencia —por ejemplo cancelación u hora por confirmar— deben tratarse de forma visible.

### Contenido musical

Cuando estén disponibles, pueden aparecer secciones editoriales claras para:

- intérpretes;
- director o solistas;
- compositores;
- programa y obras;
- ciclo o temporada;
- formato y época;
- organizador u otros datos relevantes.

El programa debe mostrarse **completo por defecto**. Sólo contenido excepcionalmente extenso debería justificar un colapso o progressive disclosure adicional.

La ficha debe evitar una colección de pequeñas cards independientes para cada atributo; se busca una lectura editorial limpia.

### Información práctica y fuente oficial

Clásica Madrid es la capa de descubrimiento y normalización, pero la fuente oficial sigue siendo la referencia final para entradas, condiciones, cambios de última hora y detalles no conservados en el catálogo.

Por ello, una acción tipo `Ver información oficial` debe tener presencia clara y relativamente protagonista.

La trazabilidad puede mantenerse además de forma discreta al final o en una zona secundaria, sin convertirse en una nota técnica dominante.

### Navegación contextual

Cuando existan relaciones objetivas útiles, al final de la ficha puede mostrarse contenido como:

- próximos eventos en el mismo lugar;
- más eventos del mismo ciclo.

No debe fabricarse un motor editorial de recomendaciones para esta primera versión.

## Dirección visual

La dirección convergida combina tres capas:

1. **editorial cultural contemporánea** como personalidad principal;
2. **programa de concierto contemporáneo** como influencia sutil;
3. **utilitaria refinada** como base de claridad, densidad y diseño de información.

El resultado debe sentirse primero como una pieza cultural contemporánea y después descubrirse como una herramienta extremadamente funcional.

La personalidad debería venir sobre todo de tipografía, ritmo, composición, jerarquía, espacio y pequeños detalles, no de decoración gratuita.

Puede explorarse una combinación tipográfica con serif y sans, o cualquier otra solución que cumpla esta dirección; no se fija una familia concreta.

Las referencias a Madrid deben ser contenidas y no literales. No se busca construir identidad mediante clichés, iconografía turística o referencias obvias a la ciudad.

Debe evitarse explícitamente el aspecto de dashboard SaaS, plantilla genérica o UI producida mecánicamente por IA.

El logo definitivo no forma parte de esta implementación. `Clásica Madrid` puede funcionar como wordmark tipográfico provisional.

No se implementará dark mode en esta primera versión.

## Alcance de la primera implementación

La primera PR de rediseño debe hacer que la interfaz pública se sienta íntegramente coherente con la nueva dirección.

Incluye, como mínimo:

- home / agenda;
- header y navegación;
- agenda responsive;
- búsqueda, shortcuts y filtros;
- ficha de evento;
- índice de lugares;
- ficha de lugar;
- footer;
- 404 y estados secundarios relevantes;
- empty states;
- sistema visual compartido necesario para sostener todo lo anterior.

Quedan fuera de alcance salvo necesidad técnica justificada:

- logo definitivo;
- dark mode;
- mapa;
- páginas nuevas de compositores o intérpretes;
- favoritos, cuentas o personalización;
- recomendaciones editoriales;
- cambios de ingestión o de datos canónicos;
- refactors de arquitectura no necesarios para la experiencia pública.

## Libertad de implementación

Este documento no es una maqueta ni una especificación pixel-perfect.

El agente tiene libertad para decidir, entre otras cosas:

- tipografías concretas;
- paleta;
- grid;
- spacing;
- tamaños;
- borders y radius;
- composición exacta de las filas;
- tratamiento gráfico de `Gratis`;
- solución concreta para filtros móviles;
- breakpoints;
- microinteracciones;
- sticky puntual si demuestra valor;
- detalles del sistema visual.

Esa libertad no debe contradecir las decisiones de producto y UX de este documento.

## Diseño con datos reales

La implementación debe probarse contra el catálogo real actual y casos incómodos, no únicamente contra ejemplos ideales.

Debe verificarse al menos:

- títulos muy largos;
- muchos intérpretes o compositores;
- programas extensos;
- hora desconocida;
- eventos gratuitos y de pago;
- municipios distintos de Madrid;
- lugares con nombres largos;
- programación institucional y pequeña/alternativa;
- muchos eventos el mismo día;
- datos parcialmente disponibles.

La solución debe ajustarse si sólo funciona con registros perfectos.

## Restricciones técnicas

Salvo razón concreta y documentada:

- Astro + TypeScript;
- Tailwind CSS v4;
- sitio static-first;
- JavaScript cliente mínimo;
- UI consumiendo `src/lib/presentation`, no JSON canónico directamente;
- ingestión y datos canónicos fuera del alcance del rediseño;
- slugs públicos estables;
- páginas públicas de eventos y lugares preservadas;
- canonicals y structured data preservados;
- mantener los contratos `data-*` / `#agenda-filter-data` mientras `agenda-client.ts` siga dependiendo de ellos, o evolucionarlos deliberadamente junto con su implementación y tests.

## Criterios de aceptación

La PR debe aspirar a cumplir, como mínimo:

- mobile-first real, no desktop simplemente encogido;
- ausencia de scroll horizontal accidental;
- buena navegación por teclado y foco visible;
- contraste adecuado y controles accesibles;
- respeto a `prefers-reduced-motion`;
- JavaScript y dependencias sólo cuando aporten valor claro;
- static-first preservado;
- búsqueda y filtros funcionales;
- URLs públicas, canonicals y structured data no rotos;
- tests existentes verdes y tests adaptados cuando cambie un contrato;
- revisión visual en varias anchuras y con casos extremos del catálogo real;
- performance al menos comparable a la base actual, evitando regresiones significativas.

El criterio cualitativo principal es que el resultado combine identidad cultural, claridad y densidad. Si parece un dashboard SaaS genérico o una interfaz típica de plantilla, la dirección visual todavía no está resuelta.

## Estado de las decisiones

Las decisiones de producto y UX necesarias para comenzar la implementación se consideran suficientemente convergidas.

Quedan abiertos deliberadamente los detalles de oficio visual, composición fina, interacción concreta y sistema de diseño que el agente debe resolver durante la implementación con datos reales.

Las ideas futuras —mapa, nuevas entidades, identidad definitiva u otras superficies de exploración— deben seguir siendo posibles, pero no deben ampliar innecesariamente el alcance de esta primera PR de rediseño.