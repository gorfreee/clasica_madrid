# RTVE / Teatro Monumental: selección de fuente y validación

> **Documentación histórica.** Registro de la selección de fuente y dry-run de RTVE / Teatro Monumental (2026-08-31). **No** es el estado operativo actual ni un requisito de implementación.
>
> Lo implementado hoy está en [`docs/ingestion.md`](../ingestion.md). El adapter y sus tests viven en el código.
>
> Consérvese como evidencia de aquella corrida. Las métricas, commits y listas de eventos de este fichero no deben copiarse a documentación vigente.

Investigación y ejecución del 31-08-2026, sobre `main` `3b1cbc3` (con ORCAM, March y el fetch relay ya incorporados).

## Mecanismo elegido

Se inspeccionaron los contratos de Ingestion v3, discovery, hydration, normalización, clasificación, identidad/reconciliation y protección de desapariciones, así como los adapters y tests de Auditorio, Teatro Real, Madrid Datos, Zarzuela, March y ORCAM.

- [Calendario de RTVE](https://www.rtve.es/orquesta-coro/programa-conciertos/): calendario HTML con `data-id-noticia`, hidratado por su propio JavaScript mediante `/api/noticias/<id>.json`. La respuesta contiene `summary` con programa, pero el calendario consultado seguía apuntando a actuaciones de enero–mayo de 2026. No se usan las fechas de publicación de las noticias como fechas de conciertos.
- [Web del Teatro Monumental](https://www.teatromonumental.es/): enlazada desde «Venta de entradas» de RTVE, con catálogo vigente 2026/27. Se comprobaron `/wp-json/`, `/wp-json/wp/v2/types` y `/wp-json/wp/v2/eventos`: el CPT de eventos no tiene ruta REST pública (404); tampoco hay ruta ACF/Events en el índice. El JSON-LD Yoast describe WebPage/Organization, sin Event ni calendario. El `filter.js` del tema sólo oculta/muestra tarjetas ya incluidas en el HTML; no pagina ni obtiene eventos por AJAX.
- El programa PDF de temporada no se usa: duplicaría el catálogo y añadiría parsing y mantenimiento innecesarios.

Se registra `orquesta-coro-rtve`, al final del registry para conservar el orden de las fuentes existentes. El adapter usa la región del catálogo y una ficha HTML por URL, sin dependencias nuevas, APIs privadas ni cambios al pipeline común. El acceso es directo; no se ha activado el relay sin evidencia de necesitarlo.

## Cobertura y hechos

El catálogo observado contiene **43 eventos / 62 funciones**, entre septiembre de 2026 y junio de 2027. Incluye abono sinfónico, Jóvenes Músicos, conciertos extraordinarios y Las Noches del Monumental. Se extraen todas las categorías: el adapter no excluye jazz, pop ni flamenco por interpretación propia.

Una tarjeta se identifica por su URL oficial; las dos fechas del mismo concierto no generan dos RawEvents. La ficha verifica la URL canónica y el título y aporta todas las parejas explícitas Fecha/Hora, el precio declarado y el texto completo del programa. Las fechas son civiles de Madrid, sin inferir años, expandir rangos ni confundirlas con horarios de taquilla. La sede se toma del alcance explícito del catálogo del propio teatro; esto no es un calendario de giras de RTVE. Se añade la sede conocida al resolver existente, sin escribir `data/`.

La edición del programa mezcla párrafos/divs y nombres en negrita sin campos inequívocos de compositor/obra/intérprete. Por eso se conserva el texto como `programText`/`description` y se dejan sus arrays vacíos: el adapter no adivina roles, no consulta knowledge musical y no corrige erratas de la fuente.

## Comportamiento conservador

- Tarjeta incompleta, URL ajena, fecha imposible, duplicado, enlace de concierto no contabilizado o paginación inesperada: fallo de extracción visible.
- Catálogo vacío: fallo visible. La clase `.no-events` está presente incluso en el catálogo lleno; no constituye una confirmación de vacío.
- Ficha sin identidad, hora/fecha inválida o pérdida de un bloque de función: fallo local, sin reemplazar un calendario por uno parcial.
- `requiresDetailSchedule` reutiliza la cobertura existente: hydration incompleta suprime desapariciones; si es severa, falla la source y bloquea auto-merge. Las fechas del listado se conservan sólo como texto observado, sin occurrences publicables antes de hidratar.
- No se cambia la clasificación, la IA, las reglas de taxonomía ni la reconciliación.

## Validación

Fixtures reales recortadas al catálogo/ficha, más mutaciones estructurales sintéticas. Los tests cubren discovery completo, varias funciones, horas distintas el mismo día, contenido vacío, preview/full, identidad incorrecta, pérdidas parciales, fallo de red, ventana, idempotencia y una coincidencia con un evento ya publicado por otra fuente. ABBA se extrae correctamente y lo excluye el clasificador común.

Comandos de dry-run (sin proveedor IA ni credenciales del relay configurados):

```bash
node --import tsx src/cli/ingest.ts source orquesta-coro-rtve --dry-run --report ingestion/reports/rtve-only/report.json
node --import tsx src/cli/ingest.ts sync --dry-run --report ingestion/reports/rtve-all/report.json
```

Se usa `node --import tsx` porque el wrapper CLI de `tsx` no puede abrir su socket IPC en este entorno (`EPERM`); ejecuta el mismo entrypoint y flags que los scripts npm, sin modificar configuración de la repo.

### Sólo RTVE, ventana 2026-08-31 → 2026-12-29

| Métrica | Resultado |
|---|---:|
| RawEvents / funciones descubiertas | 43 / 62 |
| Hydration correcta / fallida | 43 / 0 |
| Eventos / funciones dentro de ventana | 15 / 20 |
| Include / exclude / uncertain | 7 / 2 / 6 |
| Candidatos nuevos / funciones publicables | 7 / 12 |
| Descartes estructurales | 28, todos «fuera de ventana» |
| Duplicados / ambiguous / possiblyMissing | 0 / 0 / 0 |
| Escrituras al catálogo | 0 |

Health `degraded` sólo por `unresolved-taxonomy`; no hay fallos de fuente. Se revisaron los 15 eventos dentro de ventana. Los 6 inciertos son B/2 (nombres no reconocidos por el knowledge actual), Fuego y Duende (señales mixtas clásica/flamenco) y cuatro fichas escuetas de Las Noches. Se conservan inciertos sin forzar su inclusión. Los excluidos son Siempre ABBA y New York Flamenco Reunion. Jóvenes Músicos I se incluye aunque falte resolver formato.

### Todas las fuentes, misma ventana

| Métrica | Resultado |
|---|---:|
| Fuentes correctas / ejecutadas | 6 / 7 |
| RawEvents | 261 |
| Hydration correcta / fallida / no solicitada | 234 / 5 / 22 |
| Include / exclude / uncertain | 103 / 33 / 56 |
| Candidatos finales | 25 |
| Nuevos / actualizados / sin cambios | 16 / 9 / 93 |
| Descartes estructurales | 69 |
| Ambiguous / batchDuplicates / possiblyMissing | 0 / 6 / 1 |
| Escrituras al catálogo | 0 |

Health `review`, no elegible para auto-merge. Revisión de incidencias:

- Teatro Real: timeout del listado, reproducido también en una segunda ejecución aislada. No se cambia su transporte en esta PR.
- Zarzuela: 5 fichas fallidas (3 sedes externas/múltiples, 1 ficha sin secciones, 1 fecha incompatible con el día de semana); se suprimen correctamente sus desapariciones. Otras 22 fichas no se solicitan por estar fuera de ventana.
- Los 6 `batchDuplicates` son observaciones Auditorio/ORCAM del mismo evento publicado: cuatro sinfónicos (La creación de un todo, Coreografías sinfónicas, Amanecer en el recuerdo y Resonancias de Navidad) y dos de cámara (Volver a creer y Esencias de Villancicos). Ninguna involucra RTVE.
- `possiblyMissing`: Los sonidos del universo, de Madrid Datos. No afecta a RTVE y no provoca borrado/cancelación.
- Los **43 registros RTVE del report conjunto son idénticos** a los del report aislado, incluidos hechos, clasificación, identidad y candidatos. Ningún ID de candidato RTVE aparece en observaciones de otra source. No se detectaron interacciones nuevas de RTVE con el lote existente; los tests cubren además la adición de su cita a una identidad ya publicada por otra fuente.

No se presenta este dry-run como una validación limpia de todas las fuentes ni como una ejecución de producción con IA. Los reports/journals completos permanecen en `ingestion/reports/` (gitignorado); este documento conserva el resultado revisable.

Checks: la suite completa pasó con `npm test -- --maxWorkers=2` (45 suites, 681 tests). También pasaron `npm run check` (0 errores, warnings o hints), `npm run build` (185 páginas), validación del catálogo y `git diff --check`. Tras el último guard de cobertura pasaron de nuevo los 17 tests RTVE. Las repeticiones completas posteriores sufrieron timeouts de infraestructura en tests no relacionados, incluso ampliando el timeout; se interrumpieron y no se presentan como pasadas. No se relajaron aserciones ni se modificó la configuración de tests. `data/**` y `package-lock.json` permanecen intactos.

## Límites deliberados

- Cubre lo publicado en el catálogo del Teatro Monumental, no todas las actuaciones de RTVE en otras sedes ni conciertos sólo anunciados en PDF/noticias.
- Depende de las clases semánticas del tema WordPress. Los fallos de estructura se hacen visibles, pero no existe contador upstream que permita demostrar que el propio sitio no ha omitido una tarjeta completa.
- Se hidratan todas las fichas descubiertas, incluso fuera de ventana, para verificar el calendario sin introducir cambios en el mecanismo compartido de windowing. Son 44 peticiones por ejecución con el catálogo observado.
- Hay fichas sin repertorio y erratas musicales upstream (por ejemplo `Edward Grieg`); no se corrigen ni se adivinan contenidos.
- Los arrays musicales pueden quedar vacíos cuando la ficha no declara repertorio; el `kind` de un concierto en el Teatro Monumental es `established` porque el espacio pertenece al circuito habitual. Son limitaciones de enrichment de programa que no bloquean fechas, sede, procedencia ni publicación fiable.
- No hay un campo estructurado de cancelación en las fichas observadas. Una futura variante de plantilla de cancelación/reprogramación requerirá una fixture específica; las desapariciones nunca cancelan automáticamente.
- El comportamiento desde GitHub-hosted Actions con sus credenciales de IA/relay no se ha demostrado mediante estas ejecuciones locales.
