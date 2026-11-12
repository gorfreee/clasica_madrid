# Canal / Escorial: transporte y migración, 12 de noviembre de 2026

Estas capturas son evidencia de un bloqueo, **no una recuperación**.

## GitHub Actions (entorno operativo)

- Run completo: https://github.com/gorfreee/clasica_madrid/actions/runs/43236253851
- Job `probe`, Node 22 / `ubuntu-latest`, región `eastus`.
- Artifact: https://github.com/gorfreee/clasica_madrid/actions/runs/43236253851/artifacts/13952182695
- Código exacto de la sonda: https://github.com/gorfreee/clasica_madrid/blob/90da89ba7a33d5543daadbf0a3d5f3e840ad29a7/scripts/probe-tec-transport.mjs
- Workflow temporal: https://github.com/gorfreee/clasica_madrid/blob/90da89ba7a33d5543daadbf0a3d5f3e840ad29a7/.github/workflows/tec-investigation.yml

`actions-responses.json` es una copia literal del manifest del artifact. Incluye
URL oficial, transporte, status, content-type, tamaño y SHA-256 del cuerpo completo.
Los `*-403.html` son los cuerpos íntegros recibidos por el runner para la primera
página de cada API TEC. Los identificadores de petición de CloudFront son públicos;
no hay cookies ni credenciales. El relay existente devolvió `403 text/plain` con
`origin HTTP 403` (15 bytes). No se confunde con un 403 al disparar Actions: aquí
**sí se ejecutó el job y sí se contactó con el Worker autenticado**.

La ejecución anterior https://github.com/gorfreee/clasica_madrid/actions/runs/43236082322
probó las mismas rutas en directo y sólo las APIs por relay; la segunda amplió el
relay a los listados y fichas nuevos. En ambas, todas las respuestas probadas desde
Actions fueron 403. Los bodies completos de todas las rutas están en los artifacts.

## Entorno local (otra salida de red)

Los `*-redirect-200.html` son extractos de las portadas nuevas recibidas
siguiendo las URLs antiguas de TEC. Se conservaron canonical, JSON-LD, h1 y **la
primera tarjeta**; se omitieron el resto de tarjetas, navegación, scripts y assets.
Se eliminan los espacios al final de línea; los textos y campos se conservan.
No son listados exhaustivos ni fixtures positivos de TEC. URLs finales:

- https://www.cdcm.madrid/teatroscanal
- https://www.cdcm.madrid/auditorioescorial

El 12/11/2026, las URLs `https://www.teatroscanal.com/wp-json/tribe/events/v1/events`
y `https://www.teatroauditorioescorial.es/wp-json/tribe/events/v1/events`, con sus
filtros de categoría, llegaron a esas portadas con HTTP 200 `text/html`. Por eso un
200 en otra red no demuestra que TEC siga ofreciendo JSON. Los fixtures son
negativos: el parser debe rechazarlos, nunca convertirlos en agenda vacía.

Los fixtures positivos se reutilizan sin cambios de `../teatros-canal/listing.json`
y `detail-goldberg.html`, y `../teatro-auditorio-escorial/listing.json` y
`detail-10994.html`. Sus READMEs documentan su procedencia y fecha anterior.

Los escenarios que remapean el cuerpo 403 a status 200/202 y la paginación de dos
páginas son mutaciones de test explícitas, no respuestas reales atribuidas al sitio.
