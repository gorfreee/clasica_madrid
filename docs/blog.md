# Blog

El blog es contenido editorial estático. Vive en el repositorio, se valida en el build y sale prerenderizado con el resto del sitio. No hay CMS, buscador, páginas de etiquetas ni de categorías.

Para crear un nuevo artículo de principio a fin, sigue `docs/create-blog-post.md`. Este documento sigue siendo la referencia técnica del sistema editorial.

Un archivo con `draft: true` no genera URL, no sale en `/blog/`, no entra en el sitemap y no se usa como artículo relacionado.

## Dónde crear un artículo

Un archivo por artículo, sin subcarpetas:

```text
src/content/blog/{slug}.mdx
```

El slug público es el nombre del archivo: `src/content/blog/temporada-del-real.mdx` publica `/blog/temporada-del-real/`. No hace falta un campo `slug`. El nombre tiene que ser kebab-case ASCII.

Empieza siempre con `draft: true`. Quítalo, o pon `draft: false`, solo cuando el texto esté listo para publicarse.

## Frontmatter

Ejemplo mínimo:

```yaml
---
title: "Título del artículo"
description: "Entradilla breve, también usada como meta description."
publishedAt: 2026-09-01
kind: guia
heroImage: ../../assets/blog/ejemplo/hero.jpg
heroAlt: "Descripción concreta de la imagen"
tags: []
relatedVenues: []
featured: false
draft: true
---
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `title` | sí | H1 y `<title>`. El layout añade «Clásica Madrid» si no está ya. |
| `description` | sí | Entradilla visible y meta description. Máximo 300 caracteres. |
| `publishedAt` | sí | Fecha `YYYY-MM-DD`. |
| `updatedAt` | no | Misma forma. No puede ser anterior a `publishedAt`. Si existe, alimenta `article:modified_time`, `dateModified` y `lastmod`. |
| `kind` | sí | `temporada`, `guia`, `critica`, `actualidad` o `otro`. En la página, `otro` se lee «Nota». No hay índice por tipo. |
| `heroImage` | sí | Ruta relativa desde el `.mdx` hasta un archivo en `src/assets/blog/`. |
| `heroAlt` | sí | Texto alternativo real. |
| `heroCaption` | no | Pie visible bajo la imagen de apertura. |
| `heroCredit` | no | Crédito visible. No lo inventes. |
| `heroCreditUrl` | no | Solo si hay `heroCredit`. URL http(s). |
| `tags` | no | Lista de textos cortos. Sirven para artículos relacionados. No generan páginas. |
| `relatedVenues` | no | Slugs públicos de `/lugares/{slug}/`, también salas. El build falla si el slug no está en el catálogo. |
| `featured` | no | Como mucho uno destaca en `/blog/`: el publicado más reciente con `featured: true`. |
| `draft` | no | Por defecto `false`. `true` impide cualquier URL pública. |

El H1 lo pone la plantilla. Dentro del artículo, los apartados empiezan en `##`.

## Imágenes

Guárdalas en `src/assets/blog/`, preferiblemente en una carpeta por artículo. No enlaces imágenes de otros sitios.

En el cuerpo, importa el archivo y usa `Figure`:

```mdx
import detalle from '../../assets/blog/ejemplo/detalle.jpg';

<Figure src={detalle} alt="Qué se ve, de forma concreta" caption="Pie opcional." credit="Nombre del crédito" creditUrl="https://ejemplo.org/fuente" />
```

`alt` es obligatorio. `caption`, `credit` y `creditUrl` son opcionales. `creditUrl` exige `credit`.

Varias imágenes, sin carrusel:

```mdx
<Gallery>
  <Figure src={detalle} alt="Primera imagen" />
  <Figure src={otra} alt="Segunda imagen" />
</Gallery>
```

En móvil la galería se desplaza en horizontal. En pantallas anchas queda en rejilla.

La imagen de apertura (`heroImage`) es la de Open Graph y la de `BlogPosting`. No hace falta recortarla a mano a 16:9: el build genera una derivada de 1200×630 para redes y deja la proporción original en el artículo.

## Componentes

Están disponibles en el MDX sin importarlos.

| Componente | Uso |
|---|---|
| `Figure` | Imagen con pie y crédito. |
| `Gallery` | Varias `Figure`. |
| `Callout` | `title` opcional y el texto dentro. Una sola forma visual. |
| `Quote` | Cita. `attribution` opcional. |
| `YouTubeEmbed` | `id` de 11 caracteres y `title`. Muestra una miniatura; el iframe de `youtube-nocookie.com` solo se carga al pulsar reproducir. |
| `ArticleCTA` | `kind="whatsapp"`, `kind="agenda"` o `kind="internal"` con `href` interno y `title`. La plantilla pública ya añade un CTA de WhatsApp al final de cada artículo. |
| `UpcomingEvents` | Conciertos futuros del catálogo. `venue` es el slug del lugar; `limit` por defecto es 6 y como máximo 12. Sin `venue`, usa la agenda general. Si no hay conciertos, deja una frase y no rompe la página. |
| `RelatedVenue` | `slug` de un lugar. El nombre, la URL y el resumen salen del catálogo. |

Ejemplos:

```mdx
<Callout title="Contexto">
Una nota breve, no un segundo artículo.
</Callout>

<Quote attribution="Programa de mano">
Texto de la cita.
</Quote>

<YouTubeEmbed id="xxxxxxxxxxx" title="Título del vídeo" />

<ArticleCTA kind="agenda" />
<ArticleCTA kind="internal" href="/lugares/teatro-real/" title="Teatro Real" />

<UpcomingEvents venue="teatro-real" limit={6} />
<RelatedVenue slug="teatro-real" />
```

La plantilla añade automáticamente un único CTA de WhatsApp al terminar el cuerpo editorial, antes de los artículos relacionados. No hace falta insertarlo manualmente en un artículo normal.

`UpcomingEvents` acepta hoy el slug de un lugar. Compositor u otros filtros pueden añadirse después sobre la misma idea; no existen todavía.

Los artículos relacionados se calculan solos al final de la ficha, a partir de `relatedVenues`, `tags` y `kind`. No hace falta insertarlos. Un borrador nunca aparece ahí.

El índice del artículo sale de los `##` y `###`. Hace falta más de un `##`; con un solo apartado no se muestra.

Enlaces normales de Markdown sirven para la agenda (`/`), un lugar (`/lugares/{slug}/`), un concierto (`/eventos/{slug}/`) u otro artículo (`/blog/{slug}/`). Usa la barra final.

## Publicar

1. Deja `draft: true` mientras escribes. Comprueba el build: el archivo no debe crear `dist/blog/{slug}/`.
2. Revisa título, entradilla, alt, crédito y los slugs de `relatedVenues`.
3. Pon `draft: false` o elimina la línea.
4. El artículo entra en `/blog/`, en el sitemap y, si procede, como relacionado. `lastmod` es `updatedAt` o, si no existe, `publishedAt`.

No hay páginas de etiquetas, categorías, búsqueda ni paginación. No las añadas hasta que haya bastante texto publicado.
