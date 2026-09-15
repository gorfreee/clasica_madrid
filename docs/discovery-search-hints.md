# Pistas de búsqueda para Discovery

Este documento **no** es un registry de sources ni una lista exhaustiva.

Son pistas y puntos de partida. Discovery debe buscar también organizaciones, páginas y fuentes similares que **no** aparezcan aquí.

El harvesting ya cubre las sources de `SOURCE_REGISTRY` (ver `sources.harvested` en el `DiscoveryContext`). No hace falta un barrido sistemático de esas agendas. Sí puedes recoger un evento de una source ya adaptada si aparece en la investigación y no está en `coveredEvents`: es un posible coverage gap, no una orden de reimplementar el adapter.

---

## Lead de búsqueda vs evidencia canónica

| Rol | Qué es | Qué poner en el batch |
|---|---|---|
| **Lead de búsqueda** | Cómo *encontraste* el evento: Google, Eventbrite, Instagram, una agenda agregada, un cartel citado en X | `foundVia` (trazabilidad). No es source canónica. |
| **Evidencia / source** | La página que **declara** los hechos: título, fecha, lugar, programa | `source.url` (obligatoria, http/s). Preferir la oficial. `source.homepage` identifica a la organización. |

Una ficha de Eventbrite o un post de Instagram pueden llevar al evento. Si existe página oficial de la parroquia, el conservatorio, la fundación o el intérprete, **esa** es la evidencia. El agregador se queda en `foundVia`.

En hosts compartidos (Facebook, Instagram, X, Eventbrite, Meetup, …) no uses el origin de la plataforma como identidad de source. `source.homepage` debe ser el perfil concreto de esa organización.

No inventes fechas, programas, intérpretes ni URLs. Si la ficha oficial trae programa, compositores u obras, recógelos con exhaustividad razonable. Si sólo hay una agenda permanente (`/agenda`, `/eventos`, homepage), extrae **cada** concierto de esa página como observación distinta; no trates el listing como si fuera la ficha de un único evento.

---

## Tipologías útiles (con ejemplos de Madrid, no una whitelist)

Los ejemplos ilustran *dónde mirar*. Incluye equivalentes que no estén en esta página.

### Iglesias, parroquias, basílicas, diócesis

Misas-concierto, ciclos de órgano, coros parroquiales, basílicas y capillas.

Leads: sitio de la parroquia, boletín diocesano, hojas parroquiales, cartelería. Evidencia: la página del templo o de la diócesis que anuncia **ese** concierto.

Ejemplos de partida (buscar también otras parroquias y basílicas): Archidiócesis de Madrid; parroquias del centro; basílicas; iglesias con órgano histórico.

### Órgano y música religiosa

Ciclos de órgano, festivales de música sacra, capillas musicales, Scholae.

Leads: asociaciones de organistas, programas de festivales sacros, redes del titular del órgano. Evidencia: el programa del ciclo o de la iglesia.

### Coros amateurs, universitarios y semiprofesionales

Coros de cámara, orfeones, corales de universidad, agrupaciones parroquiales.

Leads: federaciones corales, blogs de la agrupación, Eventbrite de un concierto de Navidad. Evidencia: la web o el perfil estable del coro.

### Conservatorios y escuelas

RCSMM y conservatorios de distrito, escuelas municipales, centros autorizados, audiciones de fin de curso abiertas al público.

Leads: “audición pública” + nombre del centro. Evidencia: el tablón o la ficha del conservatorio.

### Universidades y colegios mayores

UCM, UAM, UC3M, universidades privadas, colegios mayores, cátedras de música, ciclos de mediación.

Leads: agendas culturales universitarias. Evidencia: la página del vicerrectorado, facultad o colegio mayor.

### Asociaciones y ensembles

Grupos de cámara, ensembles barrocos, sociedades musicales, asociaciones de amigos de la música.

Leads: nombre del ensemble + Madrid. Evidencia: su web o el ciclo que les programa.

### Centros culturales municipales y de distrito

Centros culturales, sociosanitarios y de mayores con programación de concierto clásico puntual (no la agenda municipal completa si ya la harvestea un adapter).

Leads: páginas de distrito, carteles de “ciclo de cámara”. Evidencia: la ficha del centro o del Ayuntamiento que describe **ese** evento.

### Fundaciones pequeñas

Fundaciones culturales con un puñado de conciertos al año, no las ya adaptadas.

Leads: “fundación” + “concierto” + Madrid. Evidencia: su calendario propio.

### Institutos culturales y embajadas

Institutos nacionales, embajadas, centros de lenguas, residencias culturales con recitales.

Leads: agenda del instituto o de la embajada. Evidencia: la ficha del organizador, no sólo un agregador turístico.

### Festivales pequeños

Festivales de barrio, ciclos de verano en patios, muestras de música antigua de una semana.

Leads: nombre del festival. Evidencia: el microsite o el PDF de programación del festival.

### Páginas propias de intérpretes y agrupaciones

Solistas, cuartetos y orquestas de cámara que anuncian su agenda en una web personal.

Leads: el nombre del intérprete. Evidencia: su agenda o la sala que les contrata, la que declare mejor los hechos.

### Eventbrite, Meetup y similares

Útiles como **radar**, malos como source canónica si hay página oficial.

Lead: búsqueda “música clásica”, “órgano”, “recital piano” en Madrid. Si la organizadora tiene web, persíguela. En el batch, `source.homepage` = perfil de la organizadora, no `eventbrite.com/`.

### Instagram, Facebook y X como leads

Parroquias, coros y centros pequeños anuncian primero en redes.

Lead: el post o el reel. Evidencia: el enlace a la ficha, el cartel transcrito **sólo** si los hechos están en esa captura y no inventas el resto, o la web a la que el post apunta. `foundVia` = URL del post.

### Agendas culturales relevantes

Agendas de ciudad, revistas, newsletters y portales de ocio.

Son **leads**. Casi nunca son la source oficial. Úsalas para descubrir títulos y fechas, luego abre la ficha primaria.

---

## Cómo usar estas pistas

1. Empieza por tipologías de larga cola, no por el Teatro Real ni el Auditorio.
2. Sigue el lead hasta la fuente primaria.
3. Contrasta con `coveredEvents` y `sources.*` del contexto.
4. Si no hay URL concreta que respalde el evento, no lo incluyas.
5. Si la URL concreta es un listing, una observación por evento; si hay ficha de detalle, esa es `source.url` y extrae el programa de ahí.
6. Si encuentras una organización recurrente con calendario estable, señálala en el informe al usuario como candidata a un adapter futuro. **No** añadas el adapter en esta tarea de Discovery.
