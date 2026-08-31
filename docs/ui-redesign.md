# Rediseño de interfaz — documento de trabajo

> Estado: **v0.2 / exploración**  
> Este documento es deliberadamente vivo. Recoge objetivos, principios, hipótesis y preguntas abiertas para guiar el rediseño de la interfaz de Clásica Madrid. No debe interpretarse como una especificación cerrada ni como un mandato de implementar ahora todas las ideas aquí mencionadas.

## Propósito

Clásica Madrid entra en una fase de replanteamiento amplio de su interfaz pública. La intención no es simplemente mejorar estilos sobre la UI existente, sino definir con calma qué experiencia de producto debe ofrecer la web sobre el catálogo y la arquitectura ya disponibles.

El proceso debe permitir varias conversaciones, experimentos y cambios de dirección antes de converger en una solución. La implementación final podrá realizarla un agente de IA, pero las decisiones de producto, UX y dirección visual deben quedar suficientemente claras antes de delegar esa implementación.

Este documento sirve como memoria compartida durante esa exploración.

## Norte de producto

Clásica Madrid debe aspirar a ser la forma más rápida, clara y agradable de descubrir qué música clásica se puede escuchar en Madrid, sin renunciar a la profundidad de un catálogo exhaustivo y bien estructurado.

La complejidad de los datos debe estar **disponible sin imponerse**. Una persona debería poder explorar la agenda con rapidez, pero también profundizar, filtrar y recorrer el catálogo cuando quiera hacerlo.

La interfaz no debe tratar al usuario como incapaz ni simplificar artificialmente las decisiones. Se asume una audiencia razonablemente competente. El objetivo de la simplicidad es reducir fricción y ruido, no esconder capacidades ni convertir la experiencia en algo infantil o excesivamente guiado.

## Objetivos principales

### Usabilidad

La interfaz debe ser fácil de entender, rápida de recorrer y consistente. Las acciones principales y la jerarquía de información deben resultar evidentes sin requerir aprendizaje especial.

### Profundidad

La experiencia debe funcionar tanto para una persona que simplemente quiere saber qué conciertos hay próximamente como para usuarios que quieran hacer búsquedas y filtros más específicos por fecha, lugar, compositor, intérprete, formato, época, acceso u otros atributos disponibles.

### Descubrimiento del catálogo

La agenda cronológica será una superficie central, pero **no debe concebirse como la única forma de explorar Clásica Madrid**.

El catálogo debe poder evolucionar hacia distintos modos de descubrimiento, por ejemplo:

- por agenda o fecha;
- por lugar;
- por compositor;
- por intérprete;
- por formato, época u otros atributos musicales;
- por tipo o nivel de evento;
- por acceso gratuito/de pago;
- potencialmente mediante una vista de mapa para lugares o eventos;
- otras vistas que demuestren utilidad real más adelante.

Estas posibilidades deben influir en la arquitectura de información y navegación, pero **no implican que todas deban implementarse en la primera versión del rediseño**.

### Identidad visual

La web debe resultar visualmente atractiva y reconocible, con una dirección estética deliberada y propia. Debe evitar el aspecto genérico de dashboard, plantilla SaaS o interfaz producida mecánicamente por IA.

El logo definitivo no forma parte todavía de esta fase. Durante la exploración puede utilizarse `Clásica Madrid` como wordmark tipográfico provisional. La identidad gráfica y el logo deberían desarrollarse cuando exista una dirección visual suficientemente clara.

### Rendimiento

El rendimiento debe ser excelente, especialmente en móvil. Cualquier complejidad añadida en cliente debe justificar claramente el valor de UX que aporta.

Se mantienen como principios:

- static-first con Astro;
- JavaScript cliente mínimo;
- evitar dependencias pesadas sin beneficio demostrado;
- páginas cacheables;
- imágenes opcionales, optimizadas y nunca necesarias para comprender la agenda;
- evitar layout shifts y trabajo innecesario en cliente;
- filtros y navegación con respuesta perceptualmente inmediata.

Los objetivos de rendimiento deberán convertirse en presupuestos y criterios medibles antes de cerrar la implementación.

### SEO

El SEO debe considerarse parte del diseño del producto, no una auditoría posterior.

Debe preservarse y aprovecharse la arquitectura de páginas indexables de eventos y lugares, junto con canonicals, metadatos y datos estructurados. La navegación facetada y los filtros no deben producir automáticamente un espacio incontrolado de URLs indexables.

A futuro podrán evaluarse páginas semánticas útiles para determinadas formas de descubrimiento, pero deben responder a una necesidad real de usuario y no existir únicamente para generar páginas SEO.

### Accesibilidad

La accesibilidad debe formar parte de los componentes y patrones desde el principio: HTML semántico, navegación por teclado, foco visible, contraste, targets táctiles adecuados, formularios comprensibles y respeto a preferencias como `prefers-reduced-motion`.

## Experiencia de entrada y home

La hipótesis acordada es que **la home sea esencialmente la agenda**, con una capa inicial muy ligera de identidad y orientación.

No se busca una portada separada de la utilidad principal ni una hero extensa. El usuario debería llegar casi inmediatamente a conciertos próximos, manteniendo suficiente identidad para que la página se sienta como un producto cultural propio y no como una tabla desnuda.

Una estructura de partida podría combinar:

- wordmark `Clásica Madrid`;
- una descripción breve, si aporta contexto;
- accesos temporales frecuentes;
- búsqueda y filtros;
- comienzo inmediato de la agenda.

La composición exacta, la altura de esta zona inicial y el peso relativo de cada control quedan abiertos a exploración visual.

## Responsive: una interfaz adaptada a cada contexto

El objetivo no es reducir una interfaz de escritorio hasta que quepa en móvil. Las distintas anchuras pueden justificar representaciones diferentes de los mismos datos.

### Hipótesis inicial para móvil

La hipótesis de partida es una **agenda cronológica vertical, compacta y muy escaneable**.

Cada evento debe permitir entender aproximadamente, sin abrir la ficha:

- **qué** se toca o qué ocurre;
- **quién** lo interpreta;
- **dónde**;
- **cuándo**.

Esto no implica mostrar simultáneamente todos los campos disponibles. La composición debe adaptarse a la irregularidad de los datos y mantener una jerarquía clara.

No se considera deseable convertir cada evento en una card grande y decorativa si eso reduce demasiado la densidad de información. Tampoco se parte de la idea de conservar una tabla ancha mediante scroll horizontal como experiencia móvil principal.

En música clásica, el `title` no debe asumirse como único protagonista universal. Según el evento, compositor, repertorio, intérpretes o contexto pueden explicar mejor qué va a escuchar el usuario. Los experimentos deberán comprobar cómo construir esa jerarquía sin depender de un único campo perfecto.

### Hipótesis inicial para escritorio

En pantallas grandes debe aprovecharse el espacio para ofrecer mayor densidad y capacidad de comparación.

La hipótesis principal pasa a ser una **agenda editorial de filas densas**: más flexible que una tabla rígida, pero con suficiente estructura para comparar rápidamente hora, contenido musical, intérpretes, lugar y señales relevantes.

Esta dirección debe probarse frente a alternativas más utilitarias o tabulares. No se fija todavía una representación final ni se exige ofrecer varias vistas al usuario.

### Principio de progressive disclosure

El modelo de datos puede contener muchos atributos sin que todos deban aparecer simultáneamente en cada elemento del listado.

Una posible jerarquía general es:

1. listado o agenda para evaluar rápidamente el evento;
2. ficha de evento para comprenderlo en profundidad;
3. filtros y otras vistas para navegar el catálogo desde perspectivas distintas.

## Navegación temporal

La agenda debe poder recorrerse de forma natural mediante **scroll cronológico continuo**.

Este comportamiento se complementará con accesos ligeros a momentos frecuentes, por ejemplo:

- `Hoy`;
- `Mañana`;
- `Este fin de semana`;
- selector de fecha o calendario.

No se parte de una gran vista mensual ni de una navegación obligatoriamente organizada por semanas. El calendario puede existir como mecanismo de salto, no necesariamente como representación principal del catálogo.

Los agrupadores de fecha, los saltos de mes y cualquier navegación temporal persistente deberán resolverse durante los experimentos con datos reales.

## Búsqueda y filtros

Búsqueda y filtros son capacidades relacionadas pero conceptualmente distintas.

### Búsqueda

La búsqueda debe tener presencia visible sin dominar la home. Debe concebirse desde el principio como una búsqueda sobre el catálogo, no únicamente sobre el título de los eventos.

Idealmente podrá encontrar coincidencias relevantes en elementos como:

- títulos;
- compositores;
- intérpretes;
- lugares;
- ciclos u otros textos útiles disponibles.

No se exige en esta fase una búsqueda semántica o técnicamente sofisticada. El diseño, sin embargo, no debería bloquear una evolución posterior hacia consultas más expresivas.

### Filtros

Debe evitarse tanto un formulario enorme e intimidante como una simplificación que prive al usuario avanzado de capacidad real.

Una dirección a explorar es combinar:

- accesos o shortcuts útiles para consultas frecuentes (`Hoy`, `Este fin de semana`, `Gratis`, etc.);
- un sistema de filtros avanzados accesible cuando el usuario lo necesite;
- visualización clara de filtros activos;
- eliminación individual y `Limpiar todo`;
- URLs compartibles cuando tenga sentido.

La selección exacta de shortcuts y filtros queda abierta a validación. No deben añadirse controles porque el dato exista, sino porque ayuden a descubrir conciertos.

## Programación institucional y alternativa

Los eventos de grandes instituciones, espacios consolidados, ciclos pequeños, iglesias, universidades, agrupaciones amateurs y otras fuentes deben **convivir en la misma agenda general**.

No se quiere una jerarquía editorial explícita que convierta unos eventos en principales y otros en secundarios. Tampoco se consideran deseables etiquetas grandes o repetitivas como `alternativo` que condicionen innecesariamente la lectura.

La naturaleza del evento puede comunicarse de forma sutil cuando resulte útil mediante el propio lugar, contexto, intérpretes, estilo visual u otros metadatos apropiados.

La segmentación más fuerte debe poder realizarse mediante filtros y futuras superficies de exploración por tipo o nivel de evento.

## Datos incompletos y composición adaptable

Los eventos reales tendrán grados de detalle muy diferentes. La interfaz debe asumirlo como una característica normal del catálogo.

Por defecto, un dato ausente debe **desaparecer limpiamente de la composición** en lugar de producir filas llenas de guiones, `Desconocido` o `No disponible`.

Los componentes deben poder sentirse completos con distintos niveles de riqueza de información. La ausencia sólo debería comunicarse explícitamente cuando sea relevante para poder asistir o comprender el estado del evento, por ejemplo una hora todavía por confirmar.

La UI nunca debe inferir información no respaldada para rellenar huecos visuales.

## Ficha de evento

La ficha es el lugar natural para mostrar la riqueza disponible del catálogo sin sobrecargar la agenda.

Debe poder presentar de forma clara, cuando estén disponibles:

- fecha y hora;
- lugar;
- título y contexto/ciclo;
- intérpretes;
- compositores;
- programa y obras;
- formato y época;
- acceso y precio cuando exista;
- organizadores;
- fuente y trazabilidad;
- otros datos relevantes.

Su diseño debe facilitar tanto una lectura rápida como una exploración más profunda, pero no necesita sustituir a la página original del organizador.

### Fuente oficial como acción principal

Clásica Madrid funciona como capa de descubrimiento, normalización y comparación. La **fuente oficial sigue siendo la referencia final** para detalles como entradas, condiciones de acceso, cambios de última hora, programa completo o información que el catálogo no conserve.

Por ello, la acción de ir a la fuente —por ejemplo `Ver información oficial` o equivalente— debe tener presencia clara y relativamente protagonista en la ficha del evento. No debe quedar relegada a una nota técnica de trazabilidad al final de la página.

La interfaz debe ser útil por sí misma, pero no intentar retener al usuario dentro de Clásica Madrid a costa de ocultar la fuente original.

## Lugares y otras superficies de exploración

`Agenda` y `Lugares` se consideran las **dos superficies principales iniciales** del producto.

Esto no impide que la navegación evolucione más adelante hacia compositores, intérpretes, formatos, mapa u otras entidades, pero evita introducir desde el principio demasiadas secciones de primer nivel.

### Índice de lugares

Las páginas y el índice de lugares no deben considerarse secciones secundarias puramente técnicas. Deben funcionar como una vía real para descubrir programación.

En lugar de limitarse a un directorio alfabético, conviene explorar una presentación orientada a actividad próxima, por ejemplo mostrando cuando exista:

- nombre del lugar;
- número de conciertos próximos;
- siguiente fecha con programación;
- municipio o zona cuando aporte contexto.

Debe poder distinguirse qué lugares tienen programación próxima sin crear una jerarquía editorial artificial entre instituciones grandes y espacios pequeños.

### Página de lugar

La ficha de un lugar debería poder combinar:

- nombre y localización básica;
- próximos conciertos;
- información o enlace oficial disponible;
- otros datos útiles del lugar cuando existan.

Una vista de mapa sigue siendo una posibilidad futura, no un requisito de esta primera implementación. La arquitectura y el diseño no deberían bloquearla innecesariamente.

El mismo principio puede extenderse en el futuro a compositores, intérpretes u otras entidades si el catálogo y el comportamiento de los usuarios justifican esas superficies.

## Dirección visual: territorios a explorar

Todavía no se ha elegido una estética final. Conviene explorar direcciones realmente diferentes en lugar de variantes superficiales de una misma plantilla.

Algunos territorios iniciales posibles:

- **editorial cultural contemporánea**: tipografía protagonista, ritmo editorial y sensación de agenda/revista cultural de alta calidad;
- **Madrid moderna / cívica**: referencias sutiles a ciudad, señalética o cultura madrileña sin caer en clichés;
- **programa de concierto contemporáneo**: una reinterpretación actual del mundo de programas, repertorio, papel y jerarquía tipográfica;
- **utilitaria refinada**: máxima densidad y claridad, con una estética deliberada construida alrededor de la información.

Estas direcciones son material de exploración, no opciones cerradas ni una shortlist definitiva.

## Diseño con datos reales

Los experimentos deben utilizar eventos reales y suficientemente variados del catálogo actual.

Los prototipos deben enfrentarse a casos incómodos:

- títulos muy largos;
- muchos intérpretes o compositores;
- programas extensos;
- hora desconocida;
- eventos gratuitos y de pago;
- municipios distintos de Madrid;
- lugares con nombres largos;
- eventos principales y alternativos;
- muchos eventos el mismo día;
- datos parcialmente disponibles.

Un diseño que sólo funciona con cards ficticias perfectas no es una solución válida.

## Agentes y skills de diseño

La implementación final puede apoyarse en agentes de IA y skills específicas de frontend/diseño para elevar la calidad visual y reducir patrones genéricos.

La responsabilidad debe separarse:

- este documento y futuras especificaciones definen **producto, UX, restricciones y dirección**;
- una skill de diseño puede ayudar con el oficio visual y la ejecución;
- una auditoría posterior puede revisar accesibilidad, consistencia, responsive y calidad de implementación.

Una skill no debe decidir unilateralmente la arquitectura de producto ni añadir elementos decorativos o interacciones que contradigan los principios establecidos.

Antes de la implementación final deberá decidirse qué skill o conjunto de herramientas resulta más apropiado para el agente elegido.

## Proceso propuesto

### Fase 0 — Brief

Consolidar objetivos, principios, restricciones y preguntas abiertas. Este documento inicia esa fase.

### Fase 1 — UX

Definir con más precisión:

- experiencia principal de entrada;
- arquitectura de información;
- agenda móvil;
- agenda desktop;
- navegación;
- búsqueda y filtros;
- relación listado → ficha;
- exploración por lugares y otras entidades.

### Fase 2 — Exploración

Crear varias propuestas realmente distintas utilizando el mismo conjunto de eventos reales y probándolas al menos en móvil y desktop.

La exploración debería incluir al menos una interpretación fuerte de la agenda editorial densa en desktop y una alternativa más utilitaria/tabular, sin asumir que ninguna de ellas será la solución final.

### Fase 3 — Convergencia

Elegir una dirección o combinar las mejores ideas de varias propuestas. Resolver contradicciones y dejar claras las decisiones de producto.

### Fase 4 — Sistema de diseño

Definir cuando sea útil:

- tipografía;
- color;
- spacing;
- grid;
- componentes;
- estados;
- responsive;
- interacción y motion.

### Fase 5 — Especificación

Cuando las decisiones sean suficientemente estables, condensarlas en una especificación más normativa —potencialmente `DESIGN.md`— que pueda utilizar un agente de implementación sin tener que reinterpretar conversaciones históricas.

### Fase 6 — Implementación

Rediseñar la capa de presentación respetando los contratos actuales entre dominio/presentación/UI y sin modificar ingestión o datos canónicos salvo necesidad real demostrada.

### Fase 7 — Hardening

Validar:

- responsive real;
- accesibilidad;
- SEO;
- Core Web Vitals y performance;
- navegación por teclado;
- casos extremos de contenido;
- browser/device coverage razonable;
- smoke tests y contratos funcionales existentes.

### Fase 8 — Polish e identidad

Afinar microinteracciones, detalles visuales, identidad, logo y elementos de marca una vez que la estructura y experiencia estén demostradas.

## Restricciones técnicas actuales que deben preservarse

Salvo que durante el proceso aparezca una razón concreta para cambiarlas:

- Astro + TypeScript;
- Tailwind CSS v4;
- sitio estático por defecto;
- JavaScript mínimo;
- UI consumiendo `src/lib/presentation`, no JSON canónico directamente;
- ingestión y datos canónicos fuera del alcance de un rediseño puramente visual;
- slugs públicos estables;
- páginas públicas de eventos y lugares;
- canonicals y structured data existentes;
- contratos `data-*` / `#agenda-filter-data` del filtrado actual mientras `agenda-client.ts` siga siendo la implementación de filtros.

Estos contratos pueden evolucionar si el nuevo diseño necesita otra arquitectura de interacción, pero el cambio debe ser deliberado y no accidental.

## Decisiones actuales

A fecha de esta v0.2 se consideran acordados los siguientes puntos:

1. Se hará un replanteamiento amplio de la interfaz antes de encargar una implementación final.
2. Este documento será la memoria viva de esa fase y puede cambiar sustancialmente.
3. La home será esencialmente la agenda, con una capa inicial ligera de identidad y orientación.
4. Móvil y escritorio no tienen por qué utilizar la misma representación visual.
5. El listado debe permitir entender aproximadamente qué se toca, quién lo toca, dónde y cuándo sin obligar a abrir la ficha.
6. No debe intentarse mostrar todos los atributos de un evento simultáneamente.
7. La composición debe adaptarse con elegancia a eventos con datos incompletos; la ausencia visual silenciosa será la opción por defecto.
8. La agenda se recorrerá principalmente mediante scroll cronológico continuo, complementado con shortcuts temporales y selector de fecha.
9. La búsqueda tendrá presencia visible y se concibe sobre el catálogo completo, no sólo sobre títulos.
10. Los filtros avanzados deben estar disponibles sin ocupar permanentemente la interfaz principal.
11. La hipótesis principal para desktop será una agenda editorial de filas densas, que deberá compararse con alternativas más tabulares durante la exploración.
12. Programación institucional y alternativa convivirán en la misma agenda sin jerarquía editorial explícita; podrán existir señales sutiles y filtros para distinguir tipos de evento.
13. La fuente oficial será una acción clara y relativamente protagonista en la ficha del evento.
14. `Agenda` y `Lugares` serán las dos superficies principales iniciales de exploración.
15. El índice de lugares debe ayudar a descubrir programación próxima, no limitarse a un directorio administrativo.
16. La agenda cronológica es central, pero no es la única forma futura de explorar el catálogo.
17. La experiencia debe equilibrar facilidad de uso y profundidad para usuarios avanzados, sin diseño condescendiente.
18. Performance, SEO y accesibilidad son restricciones de producto, no tareas posteriores.
19. El logo y la identidad final pueden esperar hasta que exista una dirección visual clara.
20. Las ideas futuras —incluido mapa u otras vistas del catálogo— deben permanecer abiertas sin convertirse prematuramente en alcance de implementación.

## Preguntas abiertas

Entre las preguntas que deberán resolverse en futuras iteraciones están:

- ¿Cuál debe ser la composición exacta de la zona inicial de la home y cuánto espacio debe ocupar antes de la agenda?
- ¿Qué jerarquía concreta funciona mejor para título, repertorio, compositor e intérpretes cuando los datos son irregulares?
- ¿Qué densidad exacta funciona mejor en móvil y desktop?
- ¿Cómo debe agruparse visualmente la agenda por días y meses?
- ¿Qué shortcuts temporales y de acceso aportan suficiente valor para permanecer visibles?
- ¿Cómo debe abrirse y comportarse el filtrado avanzado en móvil y desktop?
- ¿Qué capacidades debe tener la búsqueda en la primera implementación frente a evoluciones posteriores?
- ¿Qué señales visuales sutiles ayudan a diferenciar tipos de evento sin crear una jerarquía artificial?
- ¿Qué información mínima y qué acciones deben aparecer en una ficha de lugar?
- ¿Cómo se presenta el índice de lugares cuando haya muchos espacios con muy distinta frecuencia de programación?
- ¿Qué territorios visuales merece la pena convertir en prototipos reales?
- ¿Cuánto puede diferir la composición móvil de la de escritorio sin perder coherencia?
- ¿Qué presupuestos medibles de rendimiento se fijarán para la implementación final?
- ¿Qué experimentos deben realizarse antes de convertir estas decisiones en una especificación normativa?

No todas estas preguntas tienen que resolverse antes de empezar a diseñar. Parte del objetivo de los experimentos es producir evidencia para responderlas.
