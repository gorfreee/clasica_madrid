# Zarzuela y Refugio: validación de resiliencia de fuentes

Base: `c88fcde041a8e5d4e480a2c6c9ea73891fbb86a6` (main tras #351).
Incidente de referencia: Production ingestion [36877015486](https://github.com/gorfreee/clasica_madrid/actions/runs/36877015486).
Ventana de comparación: 2026-10-01 → 2027-07-31. Todas las pruebas son dry-run; `data/**` permanece intacto.

## Teatro de la Zarzuela

Se descargaron las siete fichas oficiales LIVE el 2 de octubre. Conservan K2 (`startOfPageId`, `descripcionWrapper`, título, Fechas y Horarios, Ficha Artística). **No han dejado de enumerar sus fechas**: frente a los fixtures anteriores han incorporado marcadores `17*`, `29*`, `4*`, etc., y notas «La función del … se emitirá, en directo, a través de Radio Clásica». Esas notas intercaladas provocaban `fechas no enumeradas o estructura inesperada`. Los fixtures LIVE guardan el contenido K2 íntegro, sin navegación ni assets.

El parser elimina exclusivamente esa nota reconocida y sus marcadores numéricos. Las excepciones desconocidas, calendarios ambiguos, fechas imposibles y HTML roto siguen fallando. No se amplía el rango del listing. En El barberillo, el mes y año siguen procediendo de la fecha explícita de la función accesible del mismo bloque, como antes.

| Ficha | Occurrences exactas recuperadas |
|---|---:|
| El barberillo de Lavapiés | 13 |
| El dúo de «La africana» | 5 |
| La bruja | 13 |
| La verbena de la Paloma | 10 |
| Las trece rosas rojas | 6 |
| Los gavilanes | 12 |
| Venus y Adonis | 4 |

Las pruebas comparan **todas** las fechas y horas esperadas, incluidos domingos a las 18:00 y las dos sesiones de Africana. No cuentan las notas de emisión ni las visitas táctiles como funciones.

Superficie autoritativa: K2 de temporada para descubrir fichas/rangos; calendario explícito de detail para cada representación. El listing LIVE de lírica sólo ofrece rangos, no un calendario fiable de funciones: jamás se fabrican sus endpoints ni días intermedios.

Una ficha K2 válida sin calendario propio aporta metadatos y conserva las occurrences explícitas que ya tuviera el listing. Se diagnostica `detail-no-calendar`, diferente de HTML roto/`parse-failed`. Sin calendario explícito disponible, sigue faltando cobertura y se suprimen desapariciones; no se convierte esa ausencia en un éxito silencioso de cobertura. El canonical, cuando está publicado, debe coincidir; estructura y título no vacío siguen siendo obligatorios.

## Real Hermandad del Refugio

Superficies oficiales, sin proxies: archivo `/categoria-eventos/conciertos/` → Chrome del runner cuando HTTP devuelve 202/captcha → WP REST `/wp-json/wp/v2/calendario-eventos` si ambos están bloqueados. La pantalla observada `/.well-known/captcha/` / `Robot Challenge Screen` se reconoce junto al captcha anterior de SiteGround.

En la consulta local LIVE, el archivo pasó a devolver un shell JetEngine `jet-listing-not-found` sin `data-pages` (`No hay eventos`). No se acepta como cobertura vacía verificada: se corrobora directamente mediante REST, sin esperar un selector que ese shell no contiene.

REST filtra categoría 47, status publish, orden ID ascendente y usa `_envelope=1`. Cada página debe incluir `X-WP-Total` / `X-WP-TotalPages` coherentes con `per_page`, con longitud exacta, totales estables y límites de páginas. Todas las filas deben tener identidad, título, URL oficial y categoría numérica 47; IDs/URLs duplicados invalidan el lote. No se admite una respuesta truncada aunque sea un array JSON válido. La extracción distingue este resultado verificado del parser legacy de fixtures.

REST es autoritativo para **identidad, pertenencia a categoría y cobertura de filas publicadas**, incluyendo histórico. Los campos JetEngine de fecha/lugar no están en el endpoint: se obtienen de la ficha Elementor con canonical/postid/título coincidentes. Nunca se usa `post.date` como fecha de concierto ni se asigna un año a partir de la fecha de publicación.

Un fallo de ficha conserva el calendario de las tarjetas HTML. Las observaciones REST sin ese calendario necesitan cobertura de detail; un fallo suprime desapariciones y una cobertura severamente incompleta marca fallo de fuente. Los eventos conocidos encontrados por su URL siguen marcados como vistos sin modificar su calendario. Si fallan las tres superficies, el error conserva los intentos direct/browser/REST.

## Comparación local LIVE

Comando utilizado para cada fuente y cada versión (Node `--import tsx` ejecuta el mismo CLI sin el IPC auxiliar de tsx):

```bash
node --import tsx src/cli/ingest.ts source SOURCE --dry-run \
  --from 2026-10-01 --to 2027-07-31 --report /tmp/SOURCE/report.json
```

| Métrica | Zarzuela antes | Zarzuela después | Refugio antes | Refugio después |
|---|---:|---:|---:|---:|
| RawEvents | 40 | 40 | 0 | 32 |
| Hydration correcta | 32 | 39 | 0 | 32 |
| Hydration fallida | 7 | 0 | 0 (fallo listing) | 0 |
| Fuentes fallidas | 0 | 0 | 1 | 0 |
| Possibly missing | 0 | 0 | 0 | 0 |
| Escrituras catálogo | 0 | 0 | 0 | 0 |

Antes de Zarzuela reproduce los mismos siete `parse-failed` de producción. Después conserva las mismas fichas (una fuera de ventana) y recupera sus calendarios explícitos. Refugio recupera 32 filas de concierto; 29 quedan fuera de ventana/sin fecha individual publicable. Los tres eventos conocidos se conservan sin cambios.

Los reports después siguen en `degraded` por `unresolved-taxonomy`: las pruebas sin AI no enriquecen taxonomía. No se elimina ese health reason ni ningún validation gate para obtener verde. [Evidencia compacta](zarzuela-refugio-local-evidence.json) contiene summaries y los calendarios exactos de las siete fichas.

## Verificación

- Suite local completa: 2.666 tests correctos (140 archivos).
- Astro/TypeScript: cero errores y cero warnings (dos hints preexistentes).
- Validación de catálogo y build correctos (931 páginas).
- [GitHub Actions LIVE 37001946606](https://github.com/gorfreee/clasica_madrid/actions/runs/37001946606): completado. Mismos resultados que la tabla local: Zarzuela 40 fichas, hydration 32/7 → 39/0; Refugio 0 → 32 fichas y 32/0 hydration. [Reports compactos del runner](zarzuela-refugio-runner-evidence.json); el artifact `source-resilience-evidence` conserva reports, journals y logs completos.
- Refugio en Actions: 34 peticiones **directas** HTTP 200, cero relay/browser, `listingFallback=wp-rest`. El archivo directo devuelve el shell vacío no verificable, REST aporta las 32 filas, y las 32 fichas individuales son accesibles. La ruta 202 → browser captcha → REST se cubre determinísticamente en tests; no se afirma que el bloqueo original se haya reproducido LIVE hoy.
- Zarzuela en Actions utiliza el relay INAEM ya configurado (47 peticiones HTTP 200). Las siete fichas pasan con sus calendarios enumerados. Las desapariciones siguen suprimidas: otra ficha, `Me gustan todas (Galdós y las suripantas)`, es K2 válida sin calendario explícito. Ese diagnóstico `detail-no-calendar` se mantiene; no se rebaja cobertura para reclamar una fuente completamente verificada.
- [Checks completos 37002053604](https://github.com/gorfreee/clasica_madrid/actions/runs/37002053604): validate, tests, typecheck, build y E2E completados correctamente antes de abrir la PR.

El workflow de validación utilizado es temporal y se retira del diff final. No cambia el workflow de producción ni la CI habitual.
