# Auditorio: avisos de aplazamiento — 22/10/2026

Evidencia de Production ingestion [39603845469](https://github.com/gorfreee/clasica_madrid/actions/runs/39603845469), artifact `ingestion-run-39603845469-1` (artifact ID 12348014102), y revisión manual [#384](https://github.com/gorfreee/clasica_madrid/pull/384).

`checa.html` y `osucm.html` son recortes estructurales del HTML oficial obtenido directamente el 22/10/2026. Se conservan los h4 del aviso y del programa, la columna Info y las sesiones; se omiten navegación, imagen decorativa y SVG. Las URLs de origen están en los comentarios de cada fichero y en `run-cases.json`.

`run-cases.json` copia del report las identidades, los hechos de listing y los calendarios observed/candidate anteriores. El test reconstruye una respuesta **con forma FullCalendar** a partir de esos hechos; no es una captura literal del endpoint de listing. Los ejemplos de cambio de año, horas contradictorias, avisos no resolubles y funciones múltiples se derivan de estos recortes y se identifican como variantes sintéticas.

| Caso | Aviso oficial | Calendario conservado por la ficha y por el report | Resultado efectivo |
| --- | --- | --- | --- |
| Ibermúsica / Filarmónica Checa | al 13 de NOVIEMBRE, a las 22:30H | 11/11/2026 19:30 + 13/11/2026 22:30 | sólo 13/11/2026 22:30 |
| OSUCM / COMA’26 | AL 14 de NOVIEMBRE A LAS 12:00H | 11/11/2026 19:30 + 14/11/2026 12:00 | sólo 14/11/2026 12:00 |

El año no procede del reloj ni del título COMA’26: cada destino coincide con una fecha única del calendario de la propia ficha. El botón `Aplazado` de la sesión antigua se conserva como evidencia original; el resolver no depende de él para interpretar el aviso.

Límites conservadores: sin destino explícito, sin año resoluble por esa coincidencia, con varias fechas candidatas o con discrepancia de hora en la fecha de destino, se usa el contrato existente `HydrationConflictError` / `source-conflict`. El pipeline retiene el caso, conserva la evidencia en el report y suprime desapariciones. Una ficha con varias funciones que no permite asignar de forma inequívoca el aviso singular también requiere revisión; no se sustituye globalmente su calendario ni se reparan históricos automáticamente. Una fecha nueva explícita sin hora puede permanecer sin hora; sólo el calendario de esa misma fecha puede completarla.

Las marcas `Aplazado` se leen dentro de cada bloque `eventsession` completo. Si un aviso singular no permite distinguir sesiones antiguas de funciones independientes se retiene la observación para revisión (`source-conflict`) sin borrar fechas ni IDs publicados. Regresiones sintéticas: marca ausente o invertida, tercera función válida y desplazamiento de hora dentro del mismo día.
