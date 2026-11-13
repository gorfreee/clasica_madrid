# Katarina Gurska — evidencia oficial (2026-11-13)

## Superficies comprobadas

- Agenda pública: https://katarinagurska.com/noticias-y-eventos/agenda/
- Ciclos: https://katarinagurska.com/noticias-y-eventos/programacion-cultural/ciclos-y-conciertos/
- API: `https://katarinagurska.com/wp-json/tribe/events/v1/events`.
- Ficha de ejemplo: https://katarinagurska.com/evento/escenario-joven-17-noviembre-2026/

El calendario público usa The Events Calendar. La API sin filtro de categoría
contiene las mismas diez actividades futuras de la agenda pública actual:
2 Escenario Joven, 5 Matinés en San Ildefonso y 3 actividades educativas.
La API ya devuelve la descripción completa, calendario, sede, organizador,
categorías y coste, por lo que no hace falta hidratar HTML ni descargar PDFs.
La página de ciclos no sustituye al calendario ni delimita toda su cobertura.

## Capturas

`listing.json`: GET con `start_date=2026-11-13`, `end_date=2027-03-14`,
`per_page=50`. Se conservaron los diez eventos, los totales y `rest_url`.
Se eliminaron metadatos WordPress no consumidos (autor, imágenes de cabecera,
timestamps de edición, etc.) y se recortaron categorías, organizadores y sedes
a los campos utilizados. La descripción HTML se conserva sin inventar datos.

`empty.json`: GET con `start_date=2030-11-13`, `end_date=2030-11-14`,
`per_page=50`. Vacío explícito: `events=[]`, `total=0`, `total_pages=0`, con
filtros y ventana corroborados en `rest_url`.

También se comprobó en vivo `per_page=2&page=2`: dos eventos, `total=10`,
`total_pages=5`, `rest_url` de página 2 y enlaces anterior/siguiente. Los tests
sintetizan 51 elementos a partir de una ficha real para cubrir la paginación
normal de 50; no dependen de red.

## Seguridad y límites

- Fechas/horas civiles Europe/Madrid; sin expandir intervalos a funciones diarias.
  Se conserva únicamente el inicio explícito. Los eventos de día completo no
  aportan hora. El final permanece en `listingDateText`.
- Las categorías educativas y las sedes de Segovia se conservan como hechos,
  sin decidir elegibilidad en el adapter. Las sedes no reconocidas siguen
  bloqueadas por el pipeline común; no se crean lugares automáticamente.
- Programa acotado al bloque tras el enlace explícito de programa o a párrafos
  de obras atribuidas. Los compositores proceden de encabezados con fechas
  biográficas dentro de ese programa; las fechas biográficas no son funciones.
  No se estructuran obras mediante atribuciones implícitas que puedan arrastrar
  un compositor a otra obra.
- `Auditorio Galileo` corresponde a `ven_md_fac_1921`, Centro Cultural Galileo,
  misma dirección publicada Calle Galileo 39. Se añade sólo ese alias de sede.
- La ficha KG 27377 corresponde al evento ya publicado
  `evt_madrid_datos_50441364`, `escenario-joven-2`: mismo ciclo, Galileo,
  17/11/2026 19:00 y acceso gratuito. El catálogo municipal no trae programa ni
  intérpretes; su título genérico es tratado como intérprete por el comparador
  común. Un alias de identidad explícito, limitado al 17/11, evita duplicarlo
  y conserva id/slug. No se cambia la política común de reconciliación ni data/.
  La URL municipal histórica devolvió 404 durante esta investigación; el
  calendario publicado se contrastó con la ficha vigente oficial de KG.
- Estructura/identidad/calendario inválidos, cambios de totales, páginas cortas
  o repetidas fallan toda la fuente y protegen `possiblyMissing`. El vacío sólo
  es válido con totales y filtros coherentes. Los duplicados idénticos de una
  página se consolidan; IDs con hechos contradictorios o URLs compartidas entre
  IDs se rechazan. Nunca se siguen enlaces REST devueltos por el servidor:
  cada URL de paginación se construye sobre el host y endpoint oficiales.

## Validación real contra main a2fdab3

Dry run el 13/11/2026, ventana por defecto 13/11/2026–13/03/2027:
10 observaciones, 0 fallos de fuente, 0 peticiones de hidratación,
1 alta propuesta (Escenario Joven 24/11, 19:00) y 1 actualización propuesta
(del evento ya publicado del 17/11). 0 ambigüedades, 0 duplicados y
0 `possiblyMissing`; 8 descartes estructurales por lugares no reconocidos
(5 Matinés en Segovia y las 3 actividades educativas).
Health `degraded` únicamente por `unresolved-taxonomy`: sin IA configurada,
el formato del concierto nuevo queda sin resolver. No bloquea publicación.
No se modificó `data/**` ni se versionan reports/estado local.

El ejecutable `tsx` no puede abrir su socket IPC en este entorno (`EPERM`).
Se ejecutó el mismo CLI sin ese wrapper:

```sh
node --import tsx src/cli/ingest.ts source katarina-gurska --dry-run --report ingestion/reports/katarina-gurska.json
```

Los tests comprueban extracción, identidad, calendarios, programa, paginación,
vacíos, URLs, conflictos, paso por el pipeline, idempotencia, conservación del
slug municipal y ausencia de escrituras/desapariciones ante fallos.
