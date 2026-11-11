# Regresiones de calendario del Teatro Real (2026-11-11)

Captura y journal de la ingestión programada en `b05b75a1ef82f2642cb7e3d65d7948d41624b1a4` (run [43056214891](https://github.com/gorfreee/clasica_madrid/actions/runs/43056214891), artifact `ingestion-run-43056214891-1`, ID 13872362925). No se relanzó una ingestión ni se modificó `data/**`.

- `tomatito.html`: reducción HTTP de https://www.teatroreal.es/es/espectaculo/tomatito el 2026-11-11. Se conservan el hero, la intro completa (incluido «mirando hacia adelante») y la tabla `functions-show` (21 mayo 2027, 21:00, Sala Principal). Se omite navegación, pie e imagen. El texto no se reescribe. La elegibilidad musical de Tomatito sigue siendo ajena a este fixture: aquí solo se prueba el parser de calendario.
- El aviso y el calendario corregido de Fígaro de esa misma run coinciden con `tests/fixtures/ingestion/calendar-updates-20261101/figaro.html`. El catálogo publicado en ese commit ya tiene el 9/11/2026 a las 19:30 (`occ_teatro_real_bodas_figaro_02`) y no el 11/11. Los tests construyen ese estado a partir de `teatro-real-before.json`, sin copiar el evento de producción.
