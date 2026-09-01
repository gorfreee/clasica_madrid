# Prompt — añadir una fuente a Ingestion v3

Implementa en Clásica Madrid una nueva fuente de Ingestion v3 para la fuente indicada en el mensaje que te ha remitido a este documento y abre una PR independiente, limitada a esa fuente.

Si el mensaje incluye una URL, úsala como punto de partida, no como una decisión técnica ya tomada. Si sólo incluye el nombre, identifica tú la web oficial y sus superficies relevantes.

## Aislamiento de la PR

- Parte del `main` remoto más reciente disponible al iniciar el trabajo y crea una rama nueva específica para esta fuente.
- No construyas sobre otras ramas o PRs de adapters abiertas, no incorpores su código y no intentes resolver sus conflictos.
- Implementa una sola fuente. No aproveches para refactorizar, reordenar o reformatear código compartido ni para arreglar problemas ajenos.
- Haz cambios mínimos y aditivos en los puntos compartidos inevitables —por ejemplo, `src/ingestion/registry.ts` y tests agregados—, sin reordenar imports, fuentes ni expectativas existentes.
- Si la fuente exige realmente una evolución material de la arquitectura común, no la introduzcas de forma incidental: explica el bloqueo y la alternativa más pequeña antes de continuar.

Estas reglas reducen el área de conflicto entre PRs paralelas. No conviertas la rama en una integración anticipada de otros adapters; esa integración se hará después de forma coordinada.

## Antes de modificar nada

1. Lee `AGENTS.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `docs/ingestion.md`, `docs/ingestion-v3-plan.md`, `docs/data-model.md` y `docs/classification-policy.md`.
2. Inspecciona los contratos actuales en `src/ingestion/`, el registry, los helpers compartidos y varios adapters recientes con sus tests y fixtures. Sigue los patrones vigentes; no copies a ciegas un adapter cuya fuente tenga otra forma.
3. Investiga técnicamente la web oficial en vivo antes de elegir la implementación. Examina las superficies que puedan enumerar toda la programación relevante, la paginación, los filtros, el rango temporal y las fichas.
4. Busca primero la fuente de datos oficial más estable y estructurada: API o endpoint JSON, JSON-LD útil, feed ICS/RSS, sitemap o datos embebidos. Usa scraping HTML sólo cuando no haya una alternativa mejor y limita los selectores al contenido necesario.
5. Comprueba con ejemplos reales que la superficie elegida ofrece cobertura suficiente. No confundas una portada, una selección editorial o un único ciclo con el calendario completo.

Prioriza siempre una fuente oficial o canónica. Un agregador o una plataforma de venta no debe convertirse en la fuente primaria si existe una publicación oficial. Si no hay una superficie mantenible, está bloqueada de forma insalvable o sus condiciones no permiten el uso previsto, no fuerces un scraper frágil: documenta el hallazgo y no abras una PR que aparente estar terminada.

## Implementación

- Sigue los contratos y patrones existentes de Ingestion v3. No crees una arquitectura paralela, un pipeline especial ni una dependencia nueva salvo necesidad demostrada.
- Registra la fuente mediante los mecanismos actuales y conserva su identidad, URL oficial y trazabilidad. Usa identificadores externos estables cuando existan y normaliza las URLs de forma estricta y conservadora.
- El adapter debe extraer **hechos observados**, no hacer interpretación musical o editorial. No asignes `eligibility`, `kind`, `formats`, `eras` ni otras conclusiones que correspondan a la clasificación común.
- No filtres de antemano eventos dudosos por parecer no clásicos si pertenecen a la superficie investigada: transmite los hechos disponibles y deja que el pipeline común decida. Excluye únicamente elementos que objetivamente no sean eventos individuales —por ejemplo, landings de temporada, índices o páginas de ciclo—.
- No inventes ni completes fechas, horas, sedes, precios, intérpretes, compositores, obras o estados. Conserva únicamente lo publicado de forma explícita y deja ausente lo que la fuente no sostenga.
- Usa hidratación de fichas sólo cuando aporte información útil que el listado no contenga o cuando sea necesaria para verificar identidad, calendario o sede. Mantén separadas la extracción del listado y la hidratación según los contratos actuales.
- Si la ficha es necesaria para obtener un calendario publicable, aplica las protecciones de cobertura existentes: un fallo no debe publicar ni sobrescribir un calendario incompleto ni provocar falsas desapariciones.
- Detecta paginación o carga diferida y cúbrela por completo. Si no puedes demostrar cobertura, falla de forma visible en vez de declarar éxito parcial.
- Acepta un calendario vacío sólo cuando la propia fuente muestre de forma inequívoca un estado vacío válido. HTML truncado, errores, bloqueos, cambios de plantilla o estructuras inesperadas deben degradar o fallar de forma conservadora.
- Deduplica observaciones repetidas de la misma fuente por una identidad estable y falla ante conflictos materiales que no puedan resolverse sin inferir.
- Reutiliza helpers comunes de fechas, HTML, URLs, hydration, normalización y matching cuando encajen. Añade lógica compartida sólo si existe un segundo consumidor real o una necesidad clara.
- No modifiques `data/**` durante el desarrollo ni para guardar resultados de una ejecución. Fixtures sintéticos o capturas representativas pertenecen en `tests/fixtures/`. Si el contrato actual exige excepcionalmente un cambio canónico para que el adapter funcione, justifícalo expresamente y limita el cambio al mínimo indispensable.
- No implementes fases futuras de Ingestion v3 ni cambies workflows, clasificación, reconciliación, UI o dependencias salvo que esta fuente lo requiera de manera inevitable.

## Tests y validación

Añade fixtures pequeños pero representativos y tests específicos de la fuente. Como mínimo, cubre lo que aplique de esta lista:

- extracción del listado y conservación de URLs oficiales;
- varias fechas o funciones de un mismo evento;
- hidratación de la ficha y verificación de identidad;
- paginación, múltiples superficies o ciclos cuando formen parte de la cobertura;
- deduplicación dentro de la fuente;
- fecha, hora, sede, acceso y demás hechos relevantes realmente observados;
- estructura inesperada, respuesta truncada, URL/host incorrectos y datos inválidos;
- estado vacío explícito frente a un vacío ambiguo;
- fallo local de ficha frente a fallo de cobertura de la fuente;
- recorrido del pipeline, trazabilidad, matching con eventos existentes, ausencia de duplicados, protección de `possiblyMissing` e idempotencia.

No hagas que los tests dependan de la red. Las respuestas reales que uses como fixtures deben recortarse a lo necesario, conservar las estructuras decisivas y no incluir datos inventados. Evita snapshots enormes si unas aserciones semánticas protegen mejor el contrato.

Antes de abrir la PR:

1. Ejecuta los tests específicos de la fuente y la suite completa con `npm test`.
2. Ejecuta `npm run check`, `npm run validate` y `npm run build`.
3. Ejecuta un dry run acotado con `npm run ingest:source -- <source-id> --dry-run --report ingestion/reports/<source-id>.json` cuando el origen sea accesible desde el entorno. Contrasta el recuento y una muestra de fechas, URLs y sedes con la web oficial.
4. Confirma que el dry run no ha modificado `data/**` y que no vas a commitear reports, estado local, credenciales ni artefactos temporales.
5. Revisa el diff final y elimina cualquier cambio no relacionado con esta fuente.

Si la red, un antibot o la ausencia de credenciales/relay impiden el dry run real, no simules el resultado: deja constancia de la limitación y apóyate en fixtures y tests deterministas suficientemente representativos.

## Entrega

Abre una PR lista para revisar. En la descripción incluye de forma concreta:

- superficie oficial elegida y por qué es la más estable/completa;
- endpoints o páginas cubiertos, paginación y uso de hydration;
- hechos extraídos y decisiones conservadoras ante vacíos o estructuras inesperadas;
- fixtures y casos probados;
- resultado de tests, check, validate, build y dry run real, distinguiendo lo que no se pudo ejecutar;
- limitaciones conocidas y riesgos de mantenimiento;
- lista breve de ficheros compartidos modificados para facilitar la integración posterior.

No declares éxito basándote sólo en que compila. La PR debe demostrar cobertura razonable de la fuente, seguridad ante fallos, trazabilidad, idempotencia y compatibilidad con el pipeline común.

## Mensaje mínimo para reutilizar este prompt

```text
Parte del main actual, lee docs/add-ingestion-source-agent-prompt.md e implementa como nueva fuente de Ingestion v3 «NOMBRE DE LA FUENTE» (URL OFICIAL, si se conoce). Abre una PR independiente.
```
