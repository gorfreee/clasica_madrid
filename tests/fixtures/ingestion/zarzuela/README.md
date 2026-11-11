# Teatro de la Zarzuela — fixtures

Fragmentos del HTML oficial. Se han quitado navegación, imágenes de cabecera,
comentarios y espacio en blanco irrelevantes; se conservan los contenedores K2,
etiquetas, textos y erratas observados. No son eventos de producción.

- Inicio: https://teatrodelazarzuela.inaem.gob.es/es/
- `listing-*.html`: `/es/temporada/{nombre-del-fichero-sin-listing-ni-extensión}`.
  Cada listado tiene varias filas `ul.listadoObras`, de hasta tres obras cada una.
- Fichas (30 de agosto de 2026): `verbena`, `rosas` y `double` son La verbena de
  la Paloma, Las trece rosas rojas y El dúo de la africana (lírica); `barberillo`
  es El barberillo de Lavapiés; `lied` es Christiane Karg; `family`/`school` son
  ambas Zarzuelitas; `dance` es Aión; `escolares-sala` es De la Z a la A
  (funciones escolares en la sala principal); `rosa` es Rosa León: como la cigarra.
- Fichas (6 de septiembre de 2026): `missing-schedule` es Me gustan todas
  (Galdós y las suripantas); `don-manuel` es Feliz cumpleaños: Don Manuel;
  `andromeda-escolares` y `africana-escolares` son las fichas de nuevos públicos;
  `external` es Andrómeda y Perseo (teatro musical de cámara).

La investigación encontró Joomla/K2 y JEvents. No se encontró un JSON/ICS
público utilizable: la exportación probada devolvió 403 o HTML. JEvents omite
eventos del ciclo de lied y otras secciones y repite horarios de 19:30 incluso
cuando las fichas declaran excepciones. Por eso no es el calendario primario.

Casos deliberadamente conservados: el 25 de septiembre duplicado en La verbena
(no se inventa el 26); visitas táctiles que no son funciones; fechas con hora
dominical distinta; sesiones dobles; calendario escolar independiente; rangos
explícitos con varias horas; una sede externa única; varias sedes en la misma
ficha; ficha K2 sin sección Fechas y Horarios; weekday de ficha contradictorio
con un listing de un único día.
