# Escuela Superior de Música Reina Sofía

Fixtures HTML recortados de la agenda oficial y de fichas individuales, comprobados el 15-09-2026.
Conservan la estructura contractual de tarjetas, paginación y ficha (canonical, `postid`,
título, `theme-post-content` y el shortcode de programa). Se omiten navegación, estilos
e imágenes de Elementor que no intervienen en la extracción.

El programa oficial no vive en el REST `content.rendered` (sólo el texto promocional).
Cuando está publicado aparece en `.sv-programa-evento`; si la Escuela todavía no lo ha
rellenado, el shortcode queda vacío y no deben inventarse composers/works.
`detail-83063.json` documenta esa respuesta REST incompleta; la hidratación usa el HTML.
