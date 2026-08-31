# Fundación ORCAM: incorporación y validación

Investigación y ejecuciones locales del 2026-08-31 iniciadas sobre `main`
`4ccafc7`; rama actualizada después sobre `891cb62` (PR #44, relay de Zarzuela).
Se repitieron tests/check y el dry-run de ORCAM tras el rebase. El dry-run
conjunto final ya usaba todo el código nuevo de ORCAM/identidad/reconciliation;
el único cambio de runtime del rebase es el flag de relay de Zarzuela. Sin
credenciales locales del relay, ambas versiones usan el mismo fetch directo.
El catálogo `data/**` se conserva intacto; no se publica ningún dato desde
esta PR de código.

## Mecanismo y cobertura

El [calendario oficial](https://fundacionorcam.org/programacion/) sirve las
tarjetas de conciertos completas mediante WordPress/Elementor. Se investigaron
la [API REST](https://fundacionorcam.org/wp-json/), sus tipos y la ficha:

- `concert` no aparece en `/wp-json/wp/v2/types` ni tiene rutas en el índice;
  `/wp-json/wp/v2/concert` devuelve 404.
- El JSON-LD de listado y fichas contiene `WebPage`, breadcrumbs y organización,
  sin `Event`/`MusicEvent`, fechas de concierto ni programa estructurado.
- `/feed/?post_type=concert` responde 200, pero la muestra contiene diez
  entradas de 2024–25, con `pubDate` de publicación y sin fecha/hora estructurada
  del concierto. No representa el calendario futuro actual.
- El HTML incluye JSON de Search & Filter con recuentos por mes. Se comprueba
  que cada mes coincide con las tarjetas extraídas, evitando aceptar sólo
  la primera parte de un calendario con infinite scroll.

Se usa el HTML servido, sin navegador, IA de extracción, endpoints privados,
dependencias nuevas ni relay. Los IDs son los IDs WordPress (`e-loop-item-N`),
las URLs de identidad y citas siguen siendo las fichas oficiales.
No se limita la extracción a un ciclo o temporada codificados en el adapter.

El calendario observado tiene **18 conciertos** entre octubre de 2026 y junio
de 2027: 13 del Ciclo Sinfónico y cinco de Tiempo de Cámara; dos sinfónicos
también llevan Proyecto Educativo. La cobertura se limita a lo que el
calendario publica; no se promete cubrir giras, actividades o actuaciones
que no estén enlazadas allí.

## Hydration y fallos

Las fichas aportan sede/sala, fecha y hora verificadas, agrupaciones, créditos
con rol y el programa. Compositores/obras se leen sólo de los `h4`/`h5` del
widget de programa; la prosa descriptiva no se interpreta como esos campos.
Los IDs de widgets pertenecen a la plantilla común de las fichas. No se
deducen gratuidad, organizador, formatos, épocas o elegibilidad de ORCAM.

Se verifican URL canónica, ID del concierto y los campos esenciales. Las
fechas del listado se conservan como `listingDateText`; sólo la ficha
verificada proporciona occurrences publicables. Así una hydration fallida
no sustituye fechas publicadas por una tarjeta potencialmente desactualizada.
Se reutiliza `requiresDetailSchedule`: cobertura incompleta suprime
desapariciones; cobertura severamente incompleta es fallo visible de fuente.

Se hidratan las 18 fichas, también las que quedan fuera de la ventana, para
mantener el comportamiento común de verificación de eventos existentes y
reprogramaciones. Son 19 peticiones en el calendario actual. Optimizar este
coste no necesita nuevas capas en esta iteración.

Un calendario sin tarjetas sólo se acepta con su estructura y contador
mensual explícitamente vacíos. Tarjetas incompletas, recuentos discrepantes,
paginación adicional o fechas/horas no interpretables fallan de forma visible.

## Interacción con Auditorio Nacional

Los seis conciertos de ORCAM dentro de los 120 días ya existen en el catálogo
desde Auditorio. Sus títulos allí incluyen `ORCAM. Sinfónico N.` o
`ORCAM. Tiempo de Cámara N.`. El primer dry-run detectó cinco altas que
habrían duplicado esos eventos.

Se añade una equivalencia de identidad acotada a esos dos sources y prefijos:
el resto del título debe coincidir exactamente tras la normalización común,
y también sede, fecha y **hora explícita**. Se usa tanto para buscar eventos
publicados como para agrupar nuevas observaciones. No hay fuzzy matching,
coincidencia por intérpretes, aliases por concierto ni cambio de títulos/IDs/slugs.

La segunda comprobación detectó un caso común de bootstrap: si todos los
eventos ya existen, las citas de una fuente nueva necesitaban también su
entidad Source. Reconciliation ahora adjunta las fuentes del registry
referenciadas por los candidatos y ausentes del catálogo. Esto cubre updates
y citas secundarias de nuevos eventos agrupados, sin crear fuentes sin uso.

## Validación

Ventana: **2026-08-31 → 2026-12-29**. Ejecuciones locales contra webs reales,
sin IA ni credenciales del relay; no son runs de GitHub Actions.

| Métrica | Sólo ORCAM, final | Todas las fuentes, final |
|---|---:|---:|
| Fuentes correctas / intentadas | 1 / 1 | 6 / 6 |
| RawEvents | 18 | 303 |
| Hydration correcta / intentada | 18 / 18 | 276 / 281 |
| Hydration fallida | 0 | 5 (Zarzuela) |
| Include / exclude / uncertain | 5 / 0 / 1 | 108 / 45 / 58 |
| Candidatos | 6 | 19 |
| Nuevos / actualizados / sin cambios | 0 / 6 / 0 | 9 / 10 / 107 |
| Ambiguos | 0 | 0 |
| Observaciones duplicadas agrupadas | 0 | 6 |
| Possibly missing | 0 | 1 (Madrid Datos) |
| Health | clean | review |
| Escrituras en data | 0 | 0 |

En ORCAM, los 12 descartes estructurales del report son **fuera de ventana**;
ninguno es pérdida de fecha/sede o fallo de parser. Se actualizan los seis
eventos ya publicados con la cita oficial de ORCAM y, donde procede, hechos
que antes estaban vacíos. No se renombran ni crean copias.

En el conjunto, las seis observaciones ORCAM se unen a sus seis eventos del
Auditorio. `batchDuplicates: 6` cuenta observaciones agrupadas, no seis nuevas
filas duplicadas. La política existente eleva cualquier `batch-duplicates`
a `review` y deja `autoMergeEligible: false`, incluso para estas coincidencias
exactas resueltas. No se cambia esa política dentro de la incorporación de fuente.

Otras señales del conjunto: cinco fichas fallidas de Zarzuela (se suprimen sus
desapariciones: una estructura inesperada, una fecha incompatible con el día
publicado y tres calendarios con sede externa/múltiple),
`evt_sonidos_universo_20260927` posiblemente ausente en Madrid
Datos, y taxonomía sin resolver. La primera ejecución conjunta sufrió un 403
del listado de Zarzuela; en la segunda el listado respondió, mostrando la
variabilidad del acceso directo que aborda #44. No se fuerza `health: clean`.

Comparación por `sourceId + sourceUrl` con la ejecución conjunta anterior:
**ningún cambio en observed, normalized o clasificación de las observaciones
comunes de otras fuentes**. Los nueve nuevos finales pertenecen a otras fuentes;
ORCAM aporta cero nuevos dentro de esta ventana. La señal de Madrid Datos ya
existía en la primera ejecución.

Checks finales tras actualizar sobre #44: **664 tests**, 44 ficheros, pasan
con `npm test -- --maxWorkers=2`; `npm run check` sin errores/avisos; validación
del catálogo y `npm run build` correctos. Una ejecución de la suite con workers
por defecto agotó el límite de 5 s en un test existente de carga del catálogo;
la suite completa se repitió con dos workers sin cambiar tests ni timeouts.

Comandos reproducibles:

```bash
npm test -- --maxWorkers=2
npm run check
npm run validate
npm run build
npm run ingest:source -- fundacion-orcam --dry-run --report ingestion/reports/orcam-only-final/report.json
npm run ingest:sync -- --dry-run --report ingestion/reports/orcam-all-final/report.json
git diff --exit-code -- data
```

En este contenedor el launcher `tsx` no pudo crear su socket IPC, por lo que
los comandos de ingestión/validate se ejecutaron con `node --import tsx`
sobre el mismo entrypoint (`src/cli/ingest.ts` / `src/cli/validate-data.ts`).
Los report/journal/manifest completos quedan bajo `ingestion/reports/`
(gitignorado); esta nota conserva la evidencia resumida.

Los tests cubren calendario completo/vacío/incompleto, fechas inválidas,
identidad de ficha, tres programas reales, aislamiento de fallos, ventana,
idempotencia, conservación de IDs/slugs, equivalencia cross-source con casos
negativos y bootstrap de fuentes en updates y en nuevos eventos agrupados.

## Límites conocidos

- Si cambia la plantilla Elementor, sus widgets esenciales o el contador
  mensual, se falla conservadoramente; no se adivinan posiciones alternativas.
- No se implementa paginación futura ni expansión de fechas múltiples/rangos.
  Esas estructuras nuevas requieren fixtures y una iteración explícita.
- No hay una señal estructurada de cancelación validada en las fichas
  inspeccionadas. No se infiere cancelación por desaparición ni se analiza
  libremente cualquier aviso de la página.
- `Coreografías sinfónicas` queda `uncertain` sin IA en la clasificación común.
  Sus hechos se extraen íntegramente. Si ya está publicado, se conserva y se
  añade la cita; en un catálogo vacío, queda pendiente del fallback común.
  No se modifica eligibility, knowledge base ni taxonomía para forzar include.
- Los `+`/`++` de notas del programa se conservan en algunas obras. Su limpieza
  editorial no bloquea fechas, sede, identidad ni procedencia. También se
  conservan créditos colectivos como `Johannes Brahms / Guy Braunstein` y
  erratas de la web (`AManuel de Falla`, `Edward Elga`, `Francis Poulenc/strong>`)
  como texto observado, sin corregir nombres ni separar autor/arreglista
  por inferencia. Conviene revisarlos en una iteración de limpieza de hechos.
