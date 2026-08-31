# Validación de Fundación Juan March — 2026-08-31

Base: `main` en `cdb5f53` (PR #41). No se modifica `data/**`. Adapter, hydration, clasificación y reconciliation de #40 permanecen intactos. `skipDefaultSync` sigue activo.

## Conclusión

**`fundacion-juan-march` requiere un entorno de ejecución con acceso directo a `www.march.es`.** GitHub-hosted Actions no es ese entorno. No hay un cambio de cliente HTTP, headers o runner hosted que abra el listado, y no hay un endpoint first-party alternativo que cubra el calendario presencial completo.

El siguiente paso operativo es decidir otro entorno (por ejemplo un runner self-hosted), no seguir eludiendo el bloqueo desde código.

## Evidencia de ingestión real

| Run | Código | Listing | RawEvents | Hydration | Clasificación / IA | Health | `data/**` |
|---|---|---|---|---|---|---|---|
| [`33378603348`](https://github.com/gorfreee/clasica_madrid/actions/runs/33378603348) | `main` #40 `9936aa1` | HTTP 403 | 0 | 0 | 0 | `fatal` | intacto |
| [`33380991290`](https://github.com/gorfreee/clasica_madrid/actions/runs/33380991290) | rama #41, cookie jar | HTTP 403 | 0 | 0 | 0 | `fatal` | intacto |
| [`33381711259`](https://github.com/gorfreee/clasica_madrid/actions/runs/33381711259) | `main` #41 `cdb5f53` | HTTP 403 | 0 | 0 | 0 | `fatal` | intacto |

Las tres fallan **en el primer request** a `https://www.march.es/es/madrid/conciertos`, antes de `extract()`. El parser no intervino.

En redes que reciben el 307 de nginx, `getText` reenvía el `Set-Cookie` a la misma origin y obtiene 200 (11 conciertos / 17 funciones; Andrómeda conserva seis funciones a las 18:30). Actions no llega a ese desafío: responde 403 sin `Location` ni `Set-Cookie`.

## Matriz HTTP desde GitHub-hosted runners

Workflow `March HTTP diagnostic`, [run `33383332172`](https://github.com/gorfreee/clasica_madrid/actions/runs/33383332172), rama `diagnose/march-actions-http`. Pocas peticiones por variante, sin reintentos de 403, cuerpos descartados.

Listing `https://www.march.es/es/madrid/conciertos`:

| Cliente | ubuntu-latest | macos-latest |
|---|---|---|
| Node `fetch` (headers de `getText`) | 403, sin redirect ni cookie | 403, sin redirect ni cookie |
| Node `https` (TLS distinto de undici) | 403, HTTP/1.1, TLS 1.3 | 403, HTTP/1.1, TLS 1.3 |
| Node `https` + Accept / Accept-Language / UA de navegación (sólo diagnóstico) | 403 | 403 |
| `curl` por defecto (HTTP/2) | 403 | 403 |
| `curl --http1.1` | 403 | 403 |
| `curl` + headers de navegación (sólo diagnóstico) | 403 | 403 |
| `getText` de producción | no invocado: el primer hop ya era 403 | no invocado |

Mismo host, otras rutas y hosts March:

| URL | ubuntu-latest | macos-latest | ¿Calendario completo? |
|---|---|---|---|
| `www.march.es/robots.txt` | 200 | 200 | no |
| `canal.march.es/es` | 200 | 200 | no (control de egress) |
| `www2.march.es/invitaciones/` | 200 | 200 | no: formulario de invitaciones; una ficha, una fecha |
| `recursos.march.es/` | 400 | 400 | no (almacén de media) |

El 403 no es un fallo de TLS, HTTP/2, User-Agent ni del runner Linux/Azure en concreto: macOS hosted se comporta igual. `robots.txt` en el mismo host responde 200, así que no es un corte total del hostname; el listado HTML y, por tanto, el pipeline, siguen inaccesibles.

No se implementan proxies, navegador, spoofing de UA como «solución», ni retries de un 403 determinista.

Para repetir la matriz: **Actions → March HTTP diagnostic → Run workflow** sobre la rama que contenga el workflow. No comparte el group `ingestion-production`.

## Superficies first-party (rechequeo breve)

Nada nuevo cubre descubrimiento completo + varias funciones + horas reales + URL canónica:

| Superficie | Resultado | Calendario completo |
|---|---|---|
| `www.march.es` con replay del 307 (redes que lo reciben) | 200 | sí |
| `www.march.es` desde GitHub-hosted Actions | 403 en el listing | no |
| JSON:API `/jsonapi` | 401 | no |
| `?_format=json` | 406 | no |
| `canal.march.es` | 200 | no: streaming / una función / hora de entrevista |
| ICS/Outlook del listado | — | sólo la primera función |
| `www2.march.es/musica/` | 301 al listing de `www.march.es` | no |
| `www2.march.es/calendario/` | 301 a `www.march.es/es/madrid` | no |
| `www2.march.es/invitaciones/` | 200 desde local y desde Actions | no: 1 concierto observado, 1 fecha; las fichas siguen en `www.march.es` |
| `recursos.march.es` | 400 en la raíz | no |
| PDF de temporada en `cdnrepositorios.march.es` | 200 | temporada 2025–26, no un feed |

Canal March y el formulario de invitaciones de `www2` son alcanzables desde Actions. Ninguno sustituye al listado canónico.

## Estado operativo

`skipDefaultSync` permanece. El sync programado no incluye March. `--sources fundacion-juan-march` sigue ejecutándola y un 403 sigue siendo fallo visible, no un éxito silencioso.

No reactivar el set por defecto hasta que un dry-run real desde **el entorno que vaya a operar March** descubra conciertos actuales sin HTTP 403 en el listing.
