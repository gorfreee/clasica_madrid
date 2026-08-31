# Validación de Fundación Juan March — 2026-08-31

Base inspeccionada: `main` en `9936aa1` (PR #40 mergeada). No se modifica `data/**`.

## Root cause del dry-run 33378603348

Tras el merge de #40, [la ejecución `33378603348`](https://github.com/gorfreee/clasica_madrid/actions/runs/33378603348) corrió `fundacion-juan-march` sobre ese `main`:

- listado `https://www.march.es/es/madrid/conciertos` → HTTP 403;
- 0 RawEvents, 0 hydrations, 0 llamadas de IA;
- health `fatal` por `no-sources-succeeded` y `source-failed:fundacion-juan-march`;
- `data/**` intacto.

El parser de #40 no intervino: el fallo está antes de `extract()`. Node `fetch` sigue redirecciones **sin** reenviar `Set-Cookie`. `www.march.es` responde un 307 al mismo URL con una cookie de sesión nginx; sin reenviarla, Actions recibe 403 y algunos clientes locales cierran la conexión.

## Superficies oficiales reinvestigadas

Cliente HTTP comparable a Node/GitHub Actions, sin navegador:

| Superficie | Resultado | Calendario completo |
|---|---|---|
| `www.march.es/es/madrid/conciertos` sin cookie | 307 al mismo URL | no |
| `www.march.es` reenviando el `Set-Cookie` del 307 | 200, 11 fichas, detalle Andrómeda 200 | sí |
| JSON:API `/jsonapi` | 401 Unauthorized | no |
| `?_format=json` | 406 HTML only | no |
| `canal.march.es` (Next.js, `__NEXT_DATA__`) | 200 sin cookie | no: mezcla conferencias y un streaming por acto |
| `canal.march.es/es/streaming/49477` (Andrómeda) | 200 | una función (07 oct 18:00), no las seis presenciales ni la hora visible 18:30 |
| `www2.march.es/musica/` | 301 al listado de `www.march.es` | no |
| ICS/Google/Outlook del listado | — | sólo la primera función |
| PDF de temporada en `cdnrepositorios.march.es` | 200 | 2025–26, no un feed estructurado |

No se usan mirrors ni terceros. Canal March no sustituye al listado: perdería funciones, mezclaría streaming con calendario presencial y no conserva la URL canónica `www.march.es/es/madrid/concierto/...`.

## Mecanismo

Se conserva el adapter de #40. El listado oficial [Conciertos en Madrid](https://www.march.es/es/madrid/conciertos) descubre las fichas. Sus tarjetas ya están en el HTML: «Mostrar más» revela las inicialmente ocultas, sin añadir otra página. Se limita la lectura al bloque de próximos conciertos y se comprueba el número de tarjetas declarado por el CMS.

`getText` sigue redirecciones de forma explícita y reenvía a **la misma origin** las cookies que acaba de recibir. No se cambia el User-Agent, no hay reintentos de 403/429, no hay navegador, proxies ni cookies copiadas a mano.

Cada ficha se hidrata una vez para obtener:

- Fechas, sede, modalidad presencial/mixta, estado, descripción e intérpretes del JSON-LD.
- **Hora del concierto del calendario visible**, cotejando fechas y número de funciones con el JSON-LD. En los miércoles el JSON-LD/ICS puede indicar las 18:00 de la entrevista previa, mientras la ficha anuncia el concierto a las 18:30. No se aplica un desplazamiento fijo ni se inventa una hora.
- Programa de la sección identificada por el CMS; compositores/obras sólo cuando están etiquetados explícitamente.

La URL de la ficha y su pathname son la identidad; no se usan las URLs de streaming ni los identificadores de cada función. El listado no aporta un calendario completo: un fallo de ficha no publica la primera fecha ni recorta un calendario existente. Cualquier ficha necesaria fallida suprime desapariciones de March.

## Workflow

`schedule` y `publish` siguen ejecutando código de `main`. Un `dry-run` manual usa el ref seleccionado en Actions, para poder humear una rama antes del merge. Publish desde una feature branch no puede escribir `data/**` con código no fusionado.

## Validación

Ventana por defecto. Sin modificar `data/**`. Los resultados de tests/check/validate/build y del dry-run HTTP real de GitHub Actions de esta rama se recogen en la PR.
