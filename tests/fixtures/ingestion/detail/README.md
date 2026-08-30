# Detail-page excerpts (parser samples)

Muestras estructurales pequeñas de fichas oficiales, no el golden evaluation set.

El golden set vive en `../golden/` como hechos observados. No guardar dumps HTML completos por docenas.

Los parsers están en `src/ingestion/detail/`. Añadir como mucho unos pocos excerpts por source y asertar el parser contra ellos. Páginas de producción con variaciones menores se cubren con HTML inline en tests.

Madrid Datos no tiene fixture de ficha: el JSON-LD abierto ya trae los hechos disponibles.
