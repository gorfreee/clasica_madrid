# Escuela Superior de Música Reina Sofía

Fixtures HTML recortados de la agenda oficial y de fichas individuales, comprobados el 15-09-2026.
Conservan la estructura contractual de tarjetas, paginación y ficha (canonical, `postid`,
título, `theme-post-content` y el shortcode de programa). Se omiten navegación, estilos
e imágenes de Elementor que no intervienen en la extracción.

El programa oficial no vive en el REST `content.rendered` (sólo el texto promocional).
Cuando está publicado aparece en `.sv-programa-evento`; si la Escuela todavía no lo ha
rellenado, el shortcode queda vacío y no deben inventarse composers/works.
`detail-83063.json` documenta esa respuesta REST incompleta; la hidratación usa el HTML.

## Regression #396 — captured 2026-11-01

- `listing-20261101.html`: GET https://www.escuelasuperiordemusicareinasofia.es/agenda/
  on 2026-11-01. The six complete event cards and the **empty**
  `evnt-encuentro-paginaiton-block` are retained. Navigation, styles, SVGs,
  images and unrelated carousel cards are omitted; card facts are unchanged.
- `agenda-filter-20261101.js`: GET
  https://www.escuelasuperiordemusicareinasofia.es/wp-content/themes/escuela-superior-de-musica-reina-sofia/js/agenda-filter.js
  on the same date (line endings normalized). The script makes an initial
  `agenda_event_filter_ajax_handler` POST and replaces both listing and
  pagination; a falsy `pagination_data` clears pagination. The page declares
  `ag_numero_de_eventos_a_mostrar: "9"`, while SSR contains six cards. Neither
  fact supplies an authoritative total. No AJAX recovery or single-page
  completeness inference is introduced by this change.

An empty pagination block therefore yields `IncompleteListingError` carrying
validated, in-window cards. The source remains a technical extraction failure;
no temporal coverage declaration is fabricated and disappearances stay off.
With this source alone harvesting health is `fatal`; alongside a usable source
it remains `review`. The normal multi-page contract is unchanged.

The original run 41320194642 artifact `ingestion-run-41320194642-1` confirms
zero observations and `paginación sin página actual única` in both `report.json`
and the `source-failure` journal entry in `events.jsonl`.

Capture normalization only: line endings, indentation and trailing whitespace.
