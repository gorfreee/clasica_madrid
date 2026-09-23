# Analítica de producto

Clásica Madrid usa PostHog Cloud EU en modo cookieless. La configuración vive en
`src/lib/analytics/posthog.ts` y no identifica visitantes: `cookieless_mode: 'always'`,
`person_profiles: 'never'`, sin `posthog.identify()` ni persistencia propia.

El navegador envía la analítica al Managed Reverse Proxy. `e.clasicamadrid.com`
(`api_host`) es solo el host de ingestión y assets:

```text
Browser
  → https://e.clasicamadrid.com
  → PostHog Managed Reverse Proxy
  → PostHog Cloud EU
```

La interfaz sigue en `https://eu.posthog.com` (`ui_host`). El proxy no cambia el
modelo cookieless ni añade identificación. Web Vitals sigue apagado
(`capture_performance: false`).

PostHog ya envía un `$pageview` por carga de documento y un `$pageleave`. El
autocapture, Session Replay, heatmaps y las flags están apagados. Los eventos de
esta página no sustituyen esa telemetría ni al revés: el pageview dice qué
documento se abrió; un evento semántico dice qué hizo la persona con el producto.

## Métricas

| Señal | Evento | Qué responde |
|---|---|---|
| Descubrimiento | `event_opened` | Llegó a una ficha de concierto |
| Conversión principal | `outbound_event_click` | Siguió hacia entradas, la fuente o la web del concierto |
| Asistencia probable | `directions_clicked` | Abrió el lugar en el mapa |

Funnels útiles: visita → `event_opened` → `outbound_event_click`, y visita →
`event_opened` → `directions_clicked`. La búsqueda se lee con `search_performed`
(también cuando `results_count` es 0) → `event_opened` → `outbound_event_click`.

## Pageviews

`capture_pageview` sigue siendo `true` (un pageview por carga, no `history_change`).
Los filtros de la agenda hacen `pushState` y no deben generar otro pageview.

`before_send` copia el JSON de `#analytics-page` solo sobre `$pageview` y
`$pageleave`. No es una super property: al cambiar de documento el contexto
anterior no viaja con los eventos custom. Esos eventos llevan sus propias
propiedades.

| `page_type` | Ruta |
|---|---|
| `agenda` | `/` |
| `agenda_landing` | `/agenda/{slug}/` |
| `event` | `/eventos/{slug}/` |
| `venues` | `/lugares/` |
| `venue` | `/lugares/{slug}/` |
| `about` | `/acerca-de/` |
| `contact` | `/contacto/` |
| `not_found` | 404 |
| `other` | cualquier otra ruta |

En una ficha de evento, cuando el dato existe: `event_id`, `event_title`,
`venue_id`, `venue_name`, `access`, `is_free` (solo si el acceso es `free` o
`paid`), `format` y `era` (el primer valor canónico) y `days_until_event`.
En un lugar: `venue_id` y `venue_name`. `venue_id` en un concierto es el lugar
principal, no una sala interna.

## Eventos

Los nombres y el envío están en `src/lib/analytics/product.ts`. Si PostHog no
está, la llamada no hace nada y no se espera.

| Evento | Cuándo se dispara | Propiedades | Finalidad |
|---|---|---|---|
| `search_performed` | Agenda: al enviar el buscador si la query cambió. Lugares: cuando la query se estabiliza (400 ms), no en cada tecla | `surface`, `query`, `results_count`, `active_filter_count` en la agenda | Qué se busca y si hubo resultados, incluidos los ceros |
| `filter_changed` | La persona aplica un filtro de la agenda. No en la carga ni al usar un atajo | `surface`, `filter_key`, `filter_value`, `selected`, `results_count`, `active_filter_count` | Qué filtros se usan y cuáles dejan la lista vacía |
| `quick_filter_selected` | Activa «Fin de semana» (`weekend`) o «Gratis» (`free`) | `surface`, `quick_filter`, `results_count`, `active_filter_count` | Atajos, con id estable y no con el texto visible |
| `filter_cleared` | Quita un filtro, desactiva un atajo o pulsa «Limpiar filtros» | `surface`, `filter_key` (`all` si limpia todo; `weekend` o `free` si desactiva ese atajo), `results_before`, `active_filter_count_before` | Abandono de un filtro |
| `event_opened` | Una vez por carga de una ficha de concierto, venga de la agenda o de una URL directa | `event_id`, `event_title`, `venue_id`, `venue_name`, `origin`, `access`, `is_free`, `format`, `era`, `days_until_event` | Descubrimiento |
| `outbound_event_click` | Clic en un enlace externo del concierto. No espera a PostHog ni cambia la navegación | `event_id`, `event_title`, `venue_id`, `destination_type`, `destination_domain`, `origin`, `access`, `is_free`, `format` | Conversión principal |
| `venue_opened` | Una vez por carga de una ficha de lugar | `venue_id`, `venue_name`, `origin` | Interés por un espacio |
| `directions_clicked` | Clic en la dirección, que abre Google Maps. No hay un botón «Cómo llegar» | `venue_id`, `venue_name`, `origin`, `provider` (`google_maps`) | Intención de asistencia |
| `result_list_exhausted` | El final visible de una lista, una vez por estado de resultados ya estabilizado. Otro filtro o búsqueda puede volver a contarlo. En Lugares, las teclas intermedias no son un estado | `surface`, `results_count`, `active_filter_count`, `has_search_query`, `quick_filter` | Si la gente recorre la lista |
| `share_clicked` | Compartir una ficha de concierto (nativo, WhatsApp o enlace copiado) | `event_id`, `event_title`, `channel` | Difusión de un concierto |
| `whatsapp_channel_clicked` | Clic en el enlace al canal oficial de WhatsApp | `placement` (`footer`, `about` o `agenda_inline`), `page_type` (contexto de la página actual) | Medir interés por el canal y atribuir el clic a la superficie del CTA |
| `event_feedback_clicked` | Clic en «Avísanos», al final de Fuentes en una ficha de concierto. No espera a PostHog ni retrasa la ida a `/contacto/` | `event_id`, `event_title` si existe, `placement` (`after_sources`) | Aviso de un error o cambio en la ficha, sin datos personales |
| `contact_submitted` | El `POST /api/contacto` respondió bien. No al pulsar el botón | `surface` (`contact`), `topic` si el motivo es uno de los cuatro valores del formulario. Si el envío conserva un contexto válido de ficha, también `origin` (`event_feedback`) y `event_id` | Contacto útil, sin datos personales |
| `content_shared` | Ya existía. Sigue registrando el compartir de conciertos y de lugares | `method`, `content_type`, `path` | Atribución del enlace compartido, también en lugares |

`whatsapp_channel_clicked` mide el clic de salida hacia WhatsApp. No implica que
la persona haya terminado siguiendo el canal. `placement` nombra la superficie
estable: `footer` en el pie, `about` en Acerca de y `agenda_inline` en la nota
editorial de la agenda de la portada. Ese último valor no codifica un número de
conciertos ni una posición fija; si el corte entre días cambia, el `placement`
sigue igual. La nota solo está en `/`. No se envía la URL del canal y no hay un
evento de impresión.

`event_feedback_clicked` mide el clic en «Avísanos». No implica que el mensaje
se haya enviado: eso sigue siendo `contact_submitted`, y solo después de un
`POST /api/contacto` correcto. Un contacto abierto directamente, o con una query
incompleta o manipulada, no lleva `origin` ni `event_id`. Esas dos propiedades
salen juntas y solo si el id tiene forma `evt_…`. El nombre, el email y el
mensaje no entran en el evento. `event_id` aquí es el identificador público del
catálogo, no una persona.

`destination_type` sale de la interfaz real: `tickets` es el botón «Entradas e
información oficial»; `source` es «Ver fuente original» o una cita no oficial;
`official_site` es una cita oficial en Fuentes. No hay un enlace distinto de
organizador. La web oficial de un lugar no es `outbound_event_click`: no
pertenece a un concierto. `destination_domain` es el host, sin ruta ni query.

`origin` se infiere del referrer, sin guardarlo: `search` si la agenda llevaba
`q` (aunque también hubiera filtros); `quick_filter` si solo estaban el fin de
semana y/o «Gratis», y también si el referrer es `/agenda/gratis/` o
`/agenda/fin-de-semana/` (los mismos atajos, `free` y `weekend`); `agenda` en el
resto de la home o en cualquier otra landing `/agenda/{slug}/`; `venue` desde
una ficha de lugar; `internal` desde otra página del sitio; `external` desde
otro dominio; `direct` si no hay referrer; `unknown` si el referrer no se puede
leer. Un navegador que oculte el referrer cuenta como `direct`. Volver atrás
con el historial no emite filtros otra vez.

`active_filter_count` no cuenta la búsqueda. El fin de semana cuenta como un
filtro, no como dos fechas. En `/agenda/gratis/` y `/agenda/fin-de-semana/` el
final de lista lleva `quick_filter` `free` o `weekend` y `active_filter_count`
1. Una lista estática sin ese atajo sigue en 0. `query` y los valores de texto
se recortan (120 caracteres) y se les quita el espacio sobrante.

La agenda truncada no cuenta como final de lista hasta que la lista mostrada es
la completa. Una lista vacía no emite `result_list_exhausted`; el cero queda en
`search_performed` o `filter_changed`.

En Lugares el filtrado visual sigue siendo inmediato. `result_list_exhausted`
usa la misma query estabilizada que `search_performed` (400 ms): no registra
`t`, `te` o `tea` mientras se escribe. Sin búsqueda, y al limpiar el campo, se
vuelve a medir la lista completa.

## Cookieless en producción

El sitio fija `cookieless_mode: 'always'`. PostHog solo acepta esos eventos si
el proyecto tiene activado **Cookieless server hash mode** (Project Settings →
Web analytics). Sin ese ajuste, los eventos cookieless se ignoran. Es
configuración del proyecto de PostHog, no del código de Astro. La referencia
está en la documentación de PostHog sobre [recogida de datos](https://posthog.com/docs/privacy/data-collection)
y [configuración del SDK](https://posthog.com/docs/libraries/js/config).

## Privacidad

No enviar emails, nombres, mensajes, tokens, IPs ni URLs externas con query.
Tampoco la URL de `/contacto/` con su query: el clic de aviso lleva `event_id`
y `placement`, no el enlace completo.
La query del buscador de agenda y de lugares sí: es la búsqueda del producto.
No usar cookies, `localStorage`, `sessionStorage` ni un id propio para analítica.
No llamar a `posthog.identify()` para visitas anónimas.

## Qué no añadir

Un evento custom nuevo tiene que nombrar una acción de producto que no se pueda
leer con el pageview o con los eventos de esta tabla. No hace falta un evento
por cada clic: el autocapture sigue apagado a propósito y no es el sustituto de
estos eventos. No se mide una función que la web todavía no tiene.
