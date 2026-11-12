# Recuperación de Canal y Teatro Auditorio de El Escorial

**Resultado: ambos adapters recuperan la programación desde GitHub Actions.**
La PR migra al portal público CDCM y utiliza el cliente HTTP que se ha demostrado
funcional en ese entorno. No requiere desplegar infraestructura ni cambiar secretos.
No modifica `data/**` ni hace merge.

## Diagnóstico y estrategia

La PR #405 dejó correctamente el acceso directo al antiguo WordPress porque no
había una alternativa probada. El run [43213069487](https://github.com/gorfreee/clasica_madrid/actions/runs/43213069487),
que originó #415, volvió a recibir 403 en las dos APIs. La primera investigación de
#416 probó Node fetch y el Worker existente: ambos bloqueados, también en CDCM.
Desde otra red las antiguas APIs ya redirigían a portadas HTML Drupal, no a JSON TEC.
Cambiar sólo el relay no habría reparado el contrato de extracción.

Se amplió la investigación a clientes convencionales desde runners reales:

| Cliente / petición | Agendas y dos fichas CDCM desde Actions |
| --- | --- |
| Node fetch habitual | 403 HTML CloudFront |
| Chrome headless estándar | 403 HTML CloudFront |
| curl estándar, HTTP/1.1 o HTTP/2 | 200, documentos oficiales válidos |
| curl con el mismo identificador de ingestión que Node/Worker | 403 |

La [prueba controlada](https://github.com/gorfreee/clasica_madrid/actions/runs/43243606763)
permite descartar que HTTP/2 sea necesario y demuestra que la identificación del
cliente afecta a la respuesta. No demuestra la regla interna concreta de CloudFront.
Se conserva el UA auténtico de curl; no se simula un navegador ni se accede al origin.

El registry declara `httpClient: 'curl'` para ambas fuentes, que comparten
`www.cdcm.madrid`. `getText` utiliza un GET directo con curl sólo para las rutas
públicas permitidas: listados, fichas y Views AJAX de esos centros. Tiene límites
de tiempo y tamaño, no usa shell, no sigue redirects, no envía cookies/token de
relay y valida status, content-type y URL efectiva. Los intentos siguen figurando
como HTTP directo en la observabilidad, con URL oficial, status y duración.
El resto de fuentes conserva su transporte. Un fallo de curl sigue siendo un fallo
visible de fuente/ficha; no existe un fallback a agenda vacía.

## Extracción y garantías

- Las agendas principales son las enlazadas por el portal oficial:
  `/teatroscanal/programacion/categoria/musica` y `/auditorioescorial/programacion`.
- Se contrastan canonical, configuración de la vista Drupal, ItemList, cada tarjeta,
  título, fecha con año, categoría y ficha del centro correcto. Un HTML de portada,
  error o listado truncado no sirve. Los parsers TEC y fichas antiguos permanecen
  disponibles y sus regresiones siguen pasando.
- La paginación usa el GET Views AJAX anunciado por el sitio. Las URLs HTML con
  `?page=1` se comprobaron y repiten la primera página. Los comandos AJAX deben
  corresponder al DOM id y vista solicitados. Se valida crecimiento acumulativo,
  continuidad de las tarjetas previas, ausencia de duplicados y el siguiente
  número de página, con límite de 20. Un fallo posterior conserva el progreso con
  `IncompleteListingError` y suprime desapariciones.
- Cada ficha confirma canonical/schema/ruta y título. Los metadatos de la web
  contienen el hostname `origin202603-cdcm.cdcm.madrid`: sólo se normaliza ese alias
  exacto para la misma ruta y centro; no se hace ninguna petición a ese hostname.
- Se comprueban sede/dirección del Event JSON-LD, fechas visibles y estructuradas,
  y horas con offset convertidas a Europe/Madrid. Los intervalos técnicos de día
  completo no son conciertos a medianoche. Las horas explícitas visibles completan
  el día y cualquier contradicción retiene la ficha. No se generan días a partir
  de rangos. Sesiones estructuradas solapadas sin asignación inequívoca fallan de
  forma conservadora.
- El ciclo Festival de Ensembles se separa por sus párrafos explícitos de concierto,
  fecha, hora y sala. Grupo Enigma tiene ahora una ficha propia enlazada desde el
  ciclo: se utiliza esa ficha y no se duplica su función dentro del ciclo. El
  concierto del 5 de diciembre se mantiene aunque no tenga ficha individual.
- El programa procede sólo de la ficha artística a partir de «Programa», nunca de
  notas, recomendaciones o producción. Las atribuciones ambiguas se mantienen como
  texto observado. Se conserva el reparto musical explícito.
- Tres alias revisados unen fichas de URL/título cambiados a los eventos publicados
  de Grupo Enigma, Donde nace la voz y Navidad Escorial. Están limitados a sus fechas
  observadas; no se aplican a otra temporada. Las demás coincidencias usan las
  reglas existentes por hechos. Los IDs y slugs publicados se conservan.

El portal no acredita un horizonte temporal completo. Se declara cobertura
`unknown` tras validar el listado, por lo que ambas fuentes son utilizables con
observaciones actuales, pero **no evalúan desapariciones**. Recuperar conciertos
válidos no equivale a certificar todo el calendario de la temporada.

## Prueba operativa

[Dry-run 43246192793](https://github.com/gorfreee/clasica_madrid/actions/runs/43246192793),
[artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43246192793/artifacts/13956877022):
CLI real de la rama en Node 22 / ubuntu-latest, catálogo de main y sin IA:

| Resultado | Valor |
| --- | ---: |
| Fichas extraídas Canal / Escorial | 12 / 1 |
| Observaciones tras separar el ciclo | 15 |
| Hidrataciones correctas / fallidas | 15 / 0 |
| Fuentes fallidas | 0 |
| Altas nuevas / duplicados del lote | 0 / 0 |
| Actualizaciones previstas | 11 |
| Desapariciones / escrituras | 0 / 0 |

Las 15 observaciones incluyen las dos sesiones históricas del ciclo y espectáculos
que la clasificación descarta o mantiene inciertos. No se presentan como 15 altas
clásicas. Health `degraded`: cobertura desconocida y taxonomía pendiente. Las fuentes
no tienen fallos técnicos. [Fixtures, hashes y resultados HTTP](../../tests/fixtures/ingestion/cdcm/README.md).

La [validación definitiva 43248803116](https://github.com/gorfreee/clasica_madrid/actions/runs/43248803116),
[artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43248803116/artifacts/13957228721),
ejecuta el código `5cde0534fbf37e4ebfd96b0b0cccd216078a08c2`: repite ese dry-run y
comprueba además el GET Views de la programación general desde Actions. Ambos
pasos son correctos. La última limpieza sólo retira las sondas temporales, normaliza la sangría
de fixtures y añade estos enlaces; no modifica el código operativo ya probado.

## Validación y límites

Tests positivos y negativos para ambas fuentes, cliente curl, calendario y zona
horaria, metadatos contradictorios, páginas repetidas/fallidas, ciclos, duplicación,
créditos musicales, continuidad de identidad e integridad del catálogo. Se mantiene
la suite de regresiones de los parsers anteriores. Los resultados definitivos de
suite completa, typecheck, build y E2E se enlazan en la descripción de la PR.

La prueba de producción con el pool de IA queda para la ingestión posterior al
merge. Puede cambiar decisiones de clasificación; no cambia los hechos descargados.
El sitio puede volver a modificar su HTML o su política de acceso: esos casos
siguen fallando de forma visible y conservan los eventos existentes. El entorno
operativo necesita curl, incluido en los runners Ubuntu actuales de GitHub.

## Seguimiento de publicación: PR #417

La [publicación 43258972050](https://github.com/gorfreee/clasica_madrid/actions/runs/43258972050)
leyó ambos listados, pero siete fichas de Canal devolvieron HTTP 502. Se conservaron
los eventos publicados y no se evaluaron desapariciones. El problema ya no era el
403 del antiguo WordPress: las fichas CDCM no tenían reintento de transporte.
Ambos adapters reutilizan ahora la política conservadora del listing: un único
reintento tras 750 ms ante error transitorio. El parseo queda fuera del reintento;
un HTML bloqueado, identidad o calendario contradictorio sigue fallando.

La primera repetición con el código corregido, [43325769698](https://github.com/gorfreee/clasica_madrid/actions/runs/43325769698),
[artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43325769698/artifacts/13992901697),
ejecutó la CLI de `e9626907b171e0e72674ffdb1d4f4ecf3f347845` en Node 22 y
ubuntu-latest, con el pool Gemini habilitado y límite de 30 peticiones de IA.
Trabajó sobre una copia aislada del catálogo de #417, sin publicar ni modificar
el catálogo del checkout. Recuperó las 15 observaciones, con cero fallos HTTP,
cero fichas fallidas y ambas fuentes utilizables. Todos los GET devolvieron 200:
esta repetición verifica acceso y parser operativos, pero no contiene una
recuperación de 502 real. Los tests inyectan 502 → 200 a través de getText/curl,
comprueban memoización, espera, límite y contadores de intentos.

La repetición detectó además un falso conflicto de Grupo Enigma después de guardar
su URL nueva: la comparación genérica de créditos retenía el evento pese al alias
revisado. El alias sigue vigente para su evento y fecha, antes y después de guardar
la cita; no elimina conflictos con otro evento ni evita las protecciones de fuentes
que reciclan identidades. Una fecha de otra temporada sigue sin usar el alias.
El test de identidad usa ahora un catálogo controlado en lugar del catálogo mutable.

Se revisaron las cinco propuestas de datos de esta repetición. Se incorporan las
citas faltantes del dúo García/Morinière, las dos agrupaciones jóvenes de ORCAM y
Laura Sierra, junto a los intérpretes y obras explícitos de las fichas. Se conserva
el programa canónico de Donde nace la voz: se rechaza añadir Lucio Quarantotto como
compositor de Con te partirò. La fuente mezcla créditos de autoría; la
[web oficial de Francesco Sartori](https://francescosartori.net/canzoni-colonne-sonore/)
incluye esta obra entre sus músicas. Esta revisión no fuerza una nueva atribución
ni utiliza la clasificación de IA para corregir los datos musicales.

Las decisiones inciertas de IA no crean eventos nuevos ni despublican los existentes.
La cobertura de ambas fuentes sigue siendo `unknown`; recuperar todas las fichas
del listado actual no acredita el calendario completo de la temporada.
