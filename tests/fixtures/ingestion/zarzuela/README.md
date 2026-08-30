# Teatro de la Zarzuela — fixtures

Fragmentos del HTML oficial obtenidos el 30 de agosto de 2026. Se han quitado
navegación, imágenes de cabecera, comentarios y espacio en blanco irrelevantes;
se conservan los contenedores K2, etiquetas, textos y erratas observados.
No son eventos de producción.

- Inicio: https://teatrodelazarzuela.inaem.gob.es/es/
- `listing-*.html`: `/es/temporada/{nombre-del-fichero-sin-listing-ni-extensión}`.
  Cada listado tiene varias filas `ul.listadoObras`, de hasta tres obras cada una.
- Fichas: los enlaces oficiales están en los listados. `verbena`, `rosas` y `double`
  son las fichas de La verbena de la Paloma, Las trece rosas rojas y El dúo de la
  africana; `lied` es Christiane Karg; `family`/`school` son ambas Zarzuelitas;
  `dance` es Aión; `external` es Andrómeda y Perseo (teatro musical de cámara);
  `missing-schedule` es Me gustan todas (Galdós y las suripantas), y `rosa`
  es Rosa León: como la cigarra.

La investigación encontró Joomla/K2 y JEvents. No se encontró un JSON/ICS
público utilizable: la exportación probada devolvió 403 o HTML. JEvents omite
eventos del ciclo de lied y otras secciones y repite horarios de 19:30 incluso
cuando las fichas declaran excepciones. Por eso no es el calendario primario.

Casos deliberadamente conservados: el 25 de septiembre duplicado en La verbena
(no se inventa el 26); visitas táctiles que no son funciones; fechas con hora
dominical distinta; sesiones dobles; calendario escolar independiente; sedes
externas sin un horario completo; ficha sin sección de fechas.
