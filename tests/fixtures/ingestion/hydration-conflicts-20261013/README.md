# Official detail evidence — 2026-10-13

HTML snapshots retain the source fact blocks and canonical/body identities; irrelevant head resources, scripts and styles are omitted. No dates, rooms or programme facts are edited.

| Fixture | Official URL | Evidence |
|---|---|---|
| auditorio-jupiter.html / auditorio-jupiter-listing.json | https://auditorionacional.inaem.gob.es/es/programacion/mercados-en-crescendo-orquesta-camerata-musicalis-mozart-sinfonia-41-jupiter / `/front-page-events.json?start=2026-10-18&end=2026-10-19` | Both currently give 18 October 2026, 12:00. The historical 11:30 alternative mentioned in #365 is a labelled test mutation, not a claim about the captured response. |
| coros.html | https://www.condeduquemadrid.es/actividades/festival-coros-en-el-barrio-2026 | Friendly date: 10 and 22 December; timetable: 10 December 20h, 20 December 12h. |
| navidad.html | https://www.teatroauditorioescorial.es/espectaculo/concierto-de-navidad-3 | Canonical points to `/la-tercera-de-mahler/`; visible title is Christmas concert. `itemprop=startDate` says 22 December 12:00; Fechas y Horarios says 19:00. |
| duo.html | https://teatrodelazarzuela.inaem.gob.es/es/temporada/lirica-2026-2027/el-duo-de-la-africana | HTTP 200, explicit K2 calendar; original run had three 503s. |
| rozas-9196.html | https://fundacionculturalasrozas.org/agenda/concierto-de-ano-nuevo/ | 2 ene, S - 20:00. Date/time conflicts are negative mutations of this real structure. |
| cba-67.html | https://www.circulobellasartes.com/eventos/67/ | Sala `Cafetería "La Pecera"`, espacio `Cafetería «La Pecera»`: same text with different quotes. |
| cba-akelarre.html | https://www.circulobellasartes.com/eventos/akelarre-de-mujeres-escritoras-2/ | No explicit Sala or espacio. It stays unavailable; no venue inferred. |
| alcala-otono.html | https://culturalcala.es/item_event/otono-crepuscular-a-la-luz-de-las-velas-2/ | Exact canonical and target JSON-LD excerpt. Explicit editorial header: 13 and 14 November; listing structured recurrence includes 15 November. |

Injected network errors reproduce original statuses; tests do not manufacture production events or represent mutated dates as live captures.
