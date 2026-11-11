# Evidencia original de exclusiones contextuales

`run-39603845469.json` copia las seis observaciones de `events.jsonl` del artifact
**ingestion-run-39603845469-1**, artifact ID **12348014102**, del
[run 39603845469](https://github.com/gorfreee/clasica_madrid/actions/runs/39603845469).
No procede de las fichas saneadas de `data/**` ni de los programas reconstruidos
en la [PR #384](https://github.com/gorfreee/clasica_madrid/pull/384).

El JSON conserva literalmente los campos de `observed` usados por clasificación;
sólo omite `occurrences` y `venueFacilityId`, ajenos a `ObservedFacts`. Conserva
también source/URL y la decisión original de cada observación. Los arrays vacíos,
los nombres sin normalizar y el rótulo contradictorio «Bandas sonoras» de FSO son
deliberados. SHA-256 del `events.jsonl` original:
`6e1916d98fd6201b58dddc844d4842f49556b1feefb7980367b9202c7284301d`.

Contraste del 22/10/2026 con las fuentes oficiales enlazadas en #384:

| Caso | Hechos confirmados | Resultado de las reglas |
| --- | --- | --- |
| [OCNE / Herrmann](https://auditorionacional.inaem.gob.es/es/programacion/ocne-satelite-13-bernard-herrmann-no-solo-cine) | Echoes y Souvenirs de Voyage; cuarteto de cuerda y quinteto con clarinete, no proyección | exclude → uncertain |
| [Lucía Iglesias / Marcos Madrigal](https://www.condeduquemadrid.es/actividades/lucia-iglesias-y-marcos-madrigal) | «mayor proyección de su generación» es biografía; programa de mélodies, piano y zarzuela | exclude → include |
| [Todo Chapí](https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=232e80cfb4dc0a10VgnVCM100000891ecb1aRCRD) | Cía. Taller de Zarzuela es la compañía; recital de fragmentos de Chapí | exclude → include |
| [FSO / Clasictacular](https://auditorionacional.inaem.gob.es/es/programacion/film-symphony-orchestra-clasictacular-3) | Obras clásicas enumeradas; la propia fuente las rotula «Bandas sonoras» | exclude → uncertain |
| [Cofares](https://www.teatroreal.es/es/espectaculo/xxxi-concierto-navidad) | Primera parte completa: Rachmaninov, Concierto para piano núm. 3; segunda parte: ABBA/Queen/Beatles | exclude → uncertain |
| [Donde nace la voz](https://www.teatroscanal.com/espectaculo/estibaliz-martyn-sergio-kuhlmann-donde-nace-la-voz/) | Bloque clásico/lírico con Verdi, Puccini, Chapí, Chopin y Vives, además de cine y canción | exclude → include |

Auditorio se contrastó descargando su HTML; Condeduque, Real y Canal mediante las
fichas oficiales; Todo Chapí mediante la ficha municipal oficial indexada con el
mismo `vgnextoid`. El acceso directo del buscador al Auditorio falló, pero el HTML
descargado sí contiene los programas anteriores.

## Límites que requieren una corrección independiente

- **Herrmann:** no está en la knowledge base; el adapter no estructuró sus obras
  ni sus roles y el texto no declara literalmente un recital clásico. Corregir
  la falsa proyección no inventa esa evidencia ni añade un alias por institución.
- **FSO:** la fuente contradice sus propios títulos de obras. Una forma instrumental numerada aporta contraevidencia suficiente para revisión, no conocimiento
  nuevo que identifique todo el programa como clásico. Hace falta reconocimiento
  general de obras/repertorio o una fuente adicional correctamente hidratada.
- **Cofares:** `Piano Rachmaninov.- Concierto…` quedó aplanado en una sola cadena.
  La salvaguarda de apellidos personales interpreta `Piano Rachmaninov` como un
  nombre y no resuelve al compositor. La primera parte evita el exclude, pero
  las reglas todavía no acreditan el include. Una variante diagnóstica añade
  únicamente el compositor observado a `composers[]` y demuestra que la política
  de mixtos sí lo incluye. La reparación general de límites entre créditos y
  programa pertenece a extracción/normalización, no a excepciones de eligibility.

No se relaja el grounding de IA: un span inventado se rechaza y la
coprincipalidad sin bloque clásico resuelto no puede convertirse en include por
una respuesta de IA. Tampoco se reabren los excludes deterministas.
