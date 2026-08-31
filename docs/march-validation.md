# Validación de Fundación Juan March — 2026-08-31

Base inspeccionada: `main` en `f9ac819` (incluye hardening de Zarzuela y del pool Gemini). No se modifica `data/**`.

## Mecanismo y cobertura

El listado oficial [Conciertos en Madrid](https://www.march.es/es/madrid/conciertos) descubre las fichas. Sus 11 tarjetas ya están en el HTML: «Mostrar más» revela las tres inicialmente ocultas, sin añadir otra página. Se limita la lectura al bloque de próximos conciertos, antes del siguiente `h2`, para no ingerir el carrusel del archivo. Se comprueba el número de tarjetas declarado por el CMS; una estructura desconocida o una futura paginación falla de forma visible.

No se ha podido verificar una API pública mejor. El listado contiene JSON-LD de WebSite/Organization, pero no los conciertos. Las fichas sí contienen un `@graph` de Event por función. Los enlaces ICS/Google/Outlook del listado sólo incluyen la **primera** función, por lo que no sirven como calendario completo. No se extraen horarios del PDF de temporada, que aún enlaza 2025–26.

Cada ficha se hidrata una vez para obtener:

- Fechas, sede, modalidad presencial/mixta, estado, descripción e intérpretes del JSON-LD.
- **Hora del concierto del calendario visible**, cotejando fechas y número de funciones con el JSON-LD. En los miércoles el JSON-LD/ICS puede indicar las 18:00 de la entrevista previa, mientras la ficha anuncia el concierto a las 18:30. No se aplica un desplazamiento fijo ni se inventa una hora. Se comprueban también fecha válida y día de la semana.
- Programa de la sección identificada por el CMS; compositores/obras sólo cuando están etiquetados explícitamente. Las negritas de un programa en prosa no convierten a su dramaturgo en compositor. No se interpretan repertorios, elegibilidad, épocas ni formatos en el adapter.

La URL de la ficha y su pathname son la identidad; no se usan las URLs de streaming ni los identificadores de cada función. Se reutilizan los IDs/slugs publicados de la fuente y del auditorio. La gratuidad procede de la declaración expresa del listado, no de una regla editorial por fuente.

## Fallos conservadores

El listado no aporta un calendario completo: sus RawEvents no contienen funciones publicables hasta hidratarse. Un fallo de ficha no publica la primera fecha ni recorta un calendario existente. Un flag opt-in del contrato reutiliza, sin cambiar umbrales, la cobertura de hydration y la evidencia de presencia que ya tenía Zarzuela. La lógica HTTP, reintentos y windowing de Zarzuela permanecen intactos; las demás fuentes no activan este flag.

Cualquier ficha necesaria fallida suprime desapariciones de March. Un fallo severo también marca la fuente como fallida en hydration. Se rechazan calendarios incoherentes, funciones no presenciales en Madrid y combinaciones de sedes/estados que el contrato común no puede representar sin pérdida.

## Validación

Ventana: 2026-08-31 → 2026-12-29. Sin IA: no hay credenciales locales, no se consumió cuota.

- 627 tests, `check`, validación del catálogo y build correctos. Incluye tests de fechas/horas, cambio CET/CEST, fallo parcial/total, URL oficial, identidades cross-source, bootstrap, idempotencia y ausencia de publicación fuera de ventana/cancelada.
- Dry-run HTTP de March: timeout del listado, 0 RawEvents, health `fatal`, sin escrituras. El navegador sí pudo leer el listado y las 11 fichas. Las pruebas HTTP adicionales devolvieron redirección 307 al mismo URL y respuesta vacía 444; no se añaden cookies, spoofing, navegador ni workarounds al adapter.
- Dry-run HTTP de todas las fuentes: 234 RawEvents; Auditorio, Real y Madrid Datos correctos; fallo 403 de un listado de Zarzuela y timeout de March. Health `review`; 0 nuevos, 1 actualizado, 113 unchanged, 0 ambiguos, 0 duplicados, 1 possiblyMissing de las fuentes anteriores. No demuestra disponibilidad HTTP de March.
- Replay de las capturas oficiales completas de March por el pipeline real: **11 RawEvents, 17 funciones, 11/11 fichas hidratadas, 0 descartes estructurales; 9 include, 0 exclude, 2 uncertain; 9 altas y 1 actualización; 0 ambiguos/duplicados/possiblyMissing**. Health `degraded` por taxonomía incompleta. Esta prueba inyecta capturas mediante el `get` existente; no es una ejecución HTTP exitosa.

La ejecución adicional con las cuatro fuentes por HTTP y March desde sus capturas produjo **285 RawEvents; 103 include / 45 exclude / 57 uncertain; 9 altas, 4 actualizaciones y 113 unchanged; 0 ambiguos y 0 duplicados**. De 263 hydrations intentadas, 258 funcionaron y 5 fallaron en las fuentes anteriores; 22 fichas de Zarzuela quedaron fuera de ventana. Se reprodujeron las mismas respuestas HTTP en un checkout separado de `main` (`f9ac819`): **las 274 decisiones de las otras fuentes, sus tres candidatos y el único possiblyMissing son idénticos**. El incremento es exclusivamente March (11 observaciones, 9 altas y la actualización de Andrómeda). Las capturas no ocultan el fallo de transporte: son una comprobación separada de extracción, clasificación y reconciliación.

Andrómeda se reconcilia con el evento público ya publicado (se conservan ID, slug y las seis funciones; no se mezcla con escolares). Los dos uncertain sin IA son Andrómeda y Los amigos de Kurtág; el primero conserva su clasificación canónica al ser un evento existente. No se amplía el knowledge base para forzar su inclusión.

## Pendiente antes de fusionar

Verificar un dry-run HTTP exitoso desde un entorno que llegue a March, con la rama de esta PR. El workflow actual de producción hace checkout explícito de `main`: seleccionar esta rama en «Run workflow» no basta para probarla antes del merge. El timeout local impide dar por validado el transporte. Por ello la PR se abre como draft; no se cambia el workflow de producción para esta prueba.

```bash
npm run ingest:source -- fundacion-juan-march --dry-run --report ingestion/reports/march/report.json
npm run ingest:sync -- --dry-run --report ingestion/reports/all/report.json
```

La cobertura se limita a las fichas publicadas en próximos conciertos (en esta captura, hasta 11 de noviembre). Archivo histórico, programaciones no enlazadas y enriquecimiento fino quedan para iteraciones posteriores. Las funciones con varios estados/sedes se rechazan en lugar de convertirlas en un calendario engañoso.
