# Auditorio: avisos administrativos — 11/11/2026

Evidencia de Production ingestion [43056214891](https://github.com/gorfreee/clasica_madrid/actions/runs/43056214891), artifact `ingestion-run-43056214891-1` (ID 13872362925), sobre `b05b75a1ef82f2642cb7e3d65d7948d41624b1a4`.

`checa.html` y `osucm.html` son recortes estructurales del HTML oficial pedido el 11/11/2026 por la tarde, después de ese run. Se conservan los h4, la columna Info y la sesión; se omiten navegación, imagen decorativa y SVG. A esa hora el aviso ya decía que ambos conciertos quedan cancelados.

`checa-aviso-largo.html` y `osucm-aviso-corto.html` reconstruyen el aviso de las 16:32 UTC con el mismo esqueleto h4/`br`/columna. El texto sale de las líneas de programa del `report.json` de ese artifact, no de un volcado de `observed`. La ficha en vivo ya no servía ese párrafo cuando se capturaron los recortes oficiales.

| Ficha | Aviso | Obras que el run publicó como tales |
| --- | --- | --- |
| Ibermúsica. Filarmónica Checa (`…/ibermusica-filarmonica-checa-2`) | 471 caracteres, más «Rogamos disculpen las molestias.» y la línea «Filarmónica Checa» | el aviso, la disculpa y la orquesta |
| OSUCM / COMA’26 | el mismo aviso, cortado a 284 caracteres, más la disculpa | el aviso y la disculpa |

El candidato de la Checa llevaba el aviso a 470 caracteres tras quitar el punto final y fallaba `event.works[].title` (`max(300)`). El de OSUCM mide 283 tras ese recorte y no supera el máximo: contamina las obras, pero no es la causa del error de longitud. Los dos `publication-integrity` del run (`decisión new sin destino persistible` y `decisión material sin candidato`) salen de ese único candidato inválido.

El detector compartido de calendario no trata «quedan cancelados» como `eventStatus: cancelled`. Estos recortes no amplían esa regla: el aviso sigue entrando en el texto que resuelve aplazamientos y no entra en el repertorio.
