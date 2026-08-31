# Rediseño de interfaz — documento de trabajo

> Estado: **v0.1 / exploración**  
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

## Responsive: una interfaz adaptada a cada contexto

El objetivo no es reducir una interfaz de escritorio hasta que quepa en móvil. Las distintas anchuras pueden justificar representaciones diferentes de los mismos datos.

### Hipótesis inicial para móvil

La hipótesis de partida es una **agenda cronológica vertical, compacta y muy escaneable**.

Cada evento debería mostrar sólo la información necesaria para decidir rápidamente si merece atención. El resto puede vivir en la ficha del evento o aparecer mediante progressive disclosure.

No se considera deseable convertir cada evento en una card grande y decorativa si eso reduce demasiado la densidad de información. Tampoco se parte de la idea de conservar una tabla ancha mediante scroll horizontal como experiencia móvil principal.

La composición exacta del elemento de agenda —qué peso tienen fecha, hora, título, lugar, compositores, intérpretes, formato, acceso, precio, etc.— queda abierta y debe probarse con datos reales.

### Hipótesis inicial para escritorio

En pantallas grandes sí debe aprovecharse el espacio para ofrecer mayor densidad y capacidad de comparación.

Entre las alternativas que deben explorarse están:

- una tabla de alta densidad;
- una agenda editorial estructurada en filas;
- un híbrido entre tabla y lista;
- vistas alternables, por ejemplo `Agenda` / `Tabla`, si aportan valor suficiente.

No se fija todavía que escritorio deba equivaler necesariamente a tabla.

### Principio de progressive disclosure

El modelo de datos puede contener muchos atributos sin que todos deban aparecer simultáneamente en cada elemento del listado.

Una posible jerarquía general es:

1. listado o agenda para evaluar rápidamente el evento;
2. ficha de evento para comprenderlo en profundidad;
3. filtros y otras vistas para navegar el catálogo desde perspectivas distintas.

## Búsqueda y filtros

Los filtros son una parte central del producto y merecen diseño específico.

Debe evitarse tanto un formulario enorme e intimidante como una simplificación que prive al usuario avanzado de capacidad real.

Una dirección a explorar es combinar:

- accesos o shortcuts útiles para consultas frecuentes (`Hoy`, `Mañana`, `Este fin de semana`, `Gratis`, etc.);
- búsqueda textual;
- un sistema de filtros avanzados accesible cuando el usuario lo necesite;
- visualización clara de filtros activos;
- eliminación individual y `Limpiar todo`;
- URLs compartibles cuando tenga sentido.

La selección exacta de shortcuts y filtros queda abierta a validación. No deben añadirse controles porque el dato exista, sino porque ayuden a descubrir conciertos.

## Ficha de evento

La ficha es el lugar natural para mostrar la riqueza completa del catálogo sin sobrecargar la agenda.

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

Su diseño debe facilitar tanto una lectura rápida como una exploración más profunda.

## Lugares y otras superficies de exploración

Las páginas y el índice de lugares no deben considerarse secciones secundarias puramente técnicas. Pueden convertirse en una vía importante para descubrir el catálogo.

Debe explorarse cómo podría funcionar una experiencia de lugares que permita, por ejemplo:

- recorrer espacios con programación próxima;
- entrar en un lugar y consultar su agenda;
- distinguir grandes instituciones y espacios alternativos sin crear una jerarquía editorial artificial;
- relacionar lugar, municipio y programación;
- incorporar más adelante una vista de mapa si demuestra utilidad.

La posible vista de mapa es una idea futura, no un requisito de la primera implementación. La arquitectura y el diseño no deberían bloquearla innecesariamente.

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

A fecha de esta v0.1 se consideran acordados los siguientes puntos:

1. Se hará un replanteamiento amplio de la interfaz antes de encargar una implementación final.
2. Este documento será la memoria viva de esa fase y puede cambiar sustancialmente.
3. Móvil y escritorio no tienen por qué utilizar la misma representación visual.
4. No debe intentarse mostrar todos los atributos de un evento simultáneamente.
5. La agenda cronológica es central, pero no es la única forma futura de explorar el catálogo.
6. La experiencia debe equilibrar facilidad de uso y profundidad para usuarios avanzados, sin diseño condescendiente.
7. Performance, SEO y accesibilidad son restricciones de producto, no tareas posteriores.
8. El logo y la identidad final pueden esperar hasta que exista una dirección visual clara.
9. Las ideas futuras —incluido mapa u otras vistas del catálogo— deben permanecer abiertas sin convertirse prematuramente en alcance de implementación.

## Preguntas abiertas

Entre las preguntas que deberán resolverse en futuras iteraciones están:

- ¿Qué debe ver exactamente el usuario al entrar en la home?
- ¿Qué información mínima debe contener un evento en móvil?
- ¿Qué densidad funciona mejor en desktop?
- ¿Tabla, agenda editorial, híbrido o varias vistas?
- ¿Qué shortcuts de fecha o acceso son realmente útiles?
- ¿Cómo debe abrirse y comportarse el filtrado avanzado en móvil y desktop?
- ¿Qué atributos merecen filtros visibles y cuáles deben vivir únicamente en búsqueda o detalle?
- ¿Cómo debe integrarse la exploración por lugares en la navegación principal?
- ¿Cuándo tendría sentido una vista de mapa y qué problema resolvería?
- ¿Qué dirección visual transmite mejor el carácter de Clásica Madrid?
- ¿Qué presupuestos de performance y objetivos de Core Web Vitals se adoptarán?
- ¿Qué páginas semánticas adicionales aportan valor real a usuario y SEO?
- ¿Qué nivel de interacción requiere JavaScript y qué puede mantenerse completamente estático?
- ¿Qué skill de diseño y qué metodología de auditoría se utilizarán durante implementación?

## Criterio general de decisión

Cuando haya tensión entre mostrar más información y mantener claridad, debe priorizarse que el usuario pueda **descubrir y decidir con rapidez**, dejando disponible la profundidad mediante filtros, navegación y detalle.

Cuando haya tensión entre una solución visualmente llamativa y otra más rápida, accesible y útil, la estética sólo debe ganar si aporta valor real sin deteriorar de forma significativa la experiencia.

Cuando una idea futura sea prometedora pero no necesaria para validar el rediseño, debe documentarse y mantenerse abierta en lugar de introducirla prematuramente en el alcance.