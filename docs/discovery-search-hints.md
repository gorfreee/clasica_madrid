# Pistas de búsqueda para Discovery

Este documento **no** es un registry de sources ni una lista exhaustiva.

Son pistas y puntos de partida. Discovery debe buscar también organizaciones, páginas y fuentes similares que **no** aparezcan aquí.

El harvesting ya cubre las sources de `SOURCE_REGISTRY` (ver `sources.harvested` en el `DiscoveryContext`). No hace falta un barrido sistemático de esas agendas, pero tampoco son territorio prohibido. Si una superficie externa o una búsqueda descubre un evento de una source adaptada que no está en `coveredEvents`, investígalo y puedes recogerlo como posible coverage gap; no es una orden de reimplementar el adapter.

---

## Lead de búsqueda vs evidencia canónica

| Rol | Qué es | Qué poner en el batch |
|---|---|---|
| **Lead de búsqueda** | Cómo *encontraste* el evento: Google, Eventbrite, Instagram, una agenda agregada, un cartel citado en X | `foundVia` (trazabilidad). No es source canónica. |
| **Evidencia / source** | La página que **declara** los hechos: título, fecha, lugar, programa | `source.url` (obligatoria, http/s). Preferir la oficial. `source.homepage` identifica a la organización. |

Una ficha de Eventbrite o un post de Instagram pueden llevar al evento. Si existe página oficial de la parroquia, el conservatorio, la fundación o el intérprete, **esa** es la evidencia. El agregador se queda en `foundVia`.

En hosts compartidos (Facebook, Instagram, X, Eventbrite, Meetup, …) no uses el origin de la plataforma como identidad de source. `source.homepage` debe ser el perfil concreto de esa organización.

No inventes fechas, programas, intérpretes ni URLs. Si la ficha oficial trae programa, compositores u obras, recógelos con exhaustividad razonable. Si sólo hay una agenda permanente (`/agenda`, `/eventos`, `/actividades/conciertos-de-tarde`, homepage), extrae **cada** concierto de esa página que caiga en la ventana como observación distinta —incluida paginación o load-more— y reconcilia el listing en `research.listingReviews`; no trates el listing como si fuera la ficha de un único evento.

La estrategia de búsqueda se deriva de `DiscoveryContext.window`. Antes de cerrar, comprueba que **ningún mes civil** de esa ventana (incluidos los parciales de inicio y final) haya quedado sin explorar. Puedes agrupar queries; no hace falta una búsqueda por cada tipología × mes.

## Estrategia en varias pasadas

### A. Superficies de alto recall

Revisa varias agendas amplias que puedan revelar programación poco visible: Ayuntamiento y distritos, Comunidad de Madrid, 21 DISTRITOS y equivalentes, museos estatales, Ministerio de Cultura, festivales multidisciplinares, esmadrid / Turismo Madrid y otras superficies equivalentes que aparezcan. Son radar, no necesariamente evidencia canónica.

Cuando una superficie liste varios eventos dentro de ventana, recorre la colección suficientemente —paginación y carga adicional incluidas— y reconcilia los resultados. No te limites a la portada ni a los primeros ítems.

### B. Long tail por ecosistemas

Recorre varios de los ecosistemas descritos abajo y otros equivalentes. Cambiar sólo el mes o repetir “música clásica Madrid” no constituye una estrategia diferente.

### C. Vocabulario musical

Combina Madrid, fechas, lugares o ecosistemas con términos como concierto, recital, ópera, zarzuela, barroco, renacentista, música antigua, cámara, cuarteto, trío, ensemble, órgano, coral, coro, oratorio, réquiem, cantata, lied, sinfónico y orquesta. Amplía la lista cuando la investigación sugiera otros términos.

### Recuperación

Si una primera investigación amplia produce aproximadamente 0–4 observaciones después de revisar unos 40–50 candidatos o más, añade una pasada independiente: nuevas superficies, nuevos ecosistemas, otro vocabulario, festivales/programaciones institucionales no explorados y coverage gaps. Un resultado final pequeño o vacío sigue siendo válido; lo que no vale es cerrar sólo porque la primera estrategia rindió poco.

Resume estas pasadas en `research.searchPasses`; registra enfoques, no un log de cada URL.

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

1. Ejecuta las pasadas de alto recall, long tail y vocabulario musical; no concentres todo el esfuerzo en territorio ya cubierto.
2. Sigue el lead hasta la fuente primaria.
3. Contrasta con `coveredEvents` y `sources.*` del contexto sin descartar automáticamente posibles gaps de adapters.
4. Si no hay URL concreta que respalde el evento, no lo incluyas.
5. Si la URL concreta es un listing, una observación por evento en ventana y el listing reconciliado en `listingReviews`; si hay ficha de detalle, esa es `source.url` y extrae el programa de ahí, pero no abandones el resto del listing.
6. Antes de cerrar, verifica cobertura de todos los meses civiles de `window` y aplica la regla de recuperación si el yield inicial fue anormalmente bajo.
7. Si encuentras una organización recurrente con calendario estable, señálala en el informe al usuario como candidata a un adapter futuro. **No** añadas el adapter en esta tarea de Discovery.
