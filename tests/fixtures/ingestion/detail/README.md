# Detail-page excerpts (parser samples)

Muestras estructurales pequeñas de fichas oficiales, no el golden evaluation set.

El golden set vive en `../golden/` como hechos observados. No guardar dumps HTML completos por docenas.

Los parsers están en `src/ingestion/detail/`. Añadir como mucho unos pocos excerpts por source y asertar el parser contra ellos. Páginas de producción con variaciones menores se cubren con HTML inline en tests.

Madrid Datos hidrata la ficha oficial de Madrid.es (`.detalle` / `.tiny-text`). Los excerpts cubren descripción ampliada, repertorio e intérpretes; el JSON-LD sigue siendo la fuente de fecha, lugar y acceso.
