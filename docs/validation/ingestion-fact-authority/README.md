# Ingestion v3: precedencia de hechos y falsos positivos (#351)

Base: `c88fcde041a8e5d4e480a2c6c9ea73891fbb86a6`, `main` tras fusionar #351.
No se ha modificado `data/**`.

## Antes / después

Los informes [before.json](before.json) y [after.json](after.json) contienen decisiones del pipeline, hechos del listing, hechos hidratados, normalización y Candidate final. Ambos usan el mismo catálogo posterior a #351, la misma ventana `2026-10-02 → 2027-07-31` y los mismos bytes de las fuentes (hashes SHA-256 incluidos). Sin IA live.

| Caso | Antes | Después |
|---|---|---|
| Più Mosso 2197, listing y detail | `08:00` | `time: null` al normalizar |
| Più Mosso 2197, actualización del evento corroborado en catálogo | Cambia las `19:00` reales por `08:00` | Conserva las `19:00` corroboradas; no propone `08:00` |
| Più Mosso 2197, evento nuevo sin hora corroborada (regresión de pipeline) | Hora técnica publicable | Candidate con fecha `2026-10-17` y `time: null` |
| Hannigan, Auditorio + listing CNDM con hydration fallida | Octubre y abril como `scheduled` | Sólo `2027-04-11 19:30`, `scheduled` |
| Ateneo 64667, presentación de libro | `include`, `known-classical-composer`; genera Candidate | `exclude`, `non-performance-activity`; sin Candidate |
| Golden original (68 casos): unsafe publications | 0 | 0 |
| Golden ampliado (69 casos, incluido Ateneo): unsafe publications | 1 | 0 |
| Golden original: include determinista / uncertain / exclude indebido | 34 / 2 / 0 | 34 / 2 / 0 |
| Golden original: formats / eras / access | 30/30 · 24/24 · 68/68 | 30/30 · 24/24 · 68/68 |

## Evidencia y alcance

- Descarga HTTP real el 02/10/2026: programación Più Mosso, ficha 2197, calendario JSON y ficha Hannigan del Auditorio, dos páginas de la API del Ateneo. Los parsers de producción leen las respuestas completas y verifican su cobertura. El harness de comprobación conserva sólo los tres IDs objetivo **después de `extract()`**, antes de hidratar/reconciliar. Se reproducen los mismos bytes contra base y rama. Ningún cambio de catálogo se escribe.
- Los posibles desaparecidos de una ejecución artificialmente acotada no evalúan cobertura de la fuente; por eso esos diagnósticos no se trasladan a estos informes comparativos.
- El fallo real de Hannigan requería una segunda observación: [artefacto original de #351](https://github.com/gorfreee/clasica_madrid/actions/runs/36877015486), Auditorio hidratado + CNDM cuya ficha agotó el tiempo. Se reproduce adicionalmente con fixtures oficiales, el listing de Auditorio con ambas fechas y la hydration CNDM fallida. La descarga live de Auditorio por sí sola no reproduce esa unión. Las regresiones comprueban ambos órdenes de las fuentes y tanto Candidate nuevo como actualización.
- `dateFromDetail` domina un calendario sin esa marca en ambas rutas (`overlayNormalizedFacts` y `mergeProposals`). Dos calendarios con la misma autoridad mantienen la unión previa. No se crean occurrences históricas ni estados nuevos, ni se cambian IDs/semántica de JSON-LD.
- `DetailOccurrence.time: null` rechaza explícitamente heredar una hora del listing. `undefined` conserva el fallback existente, incluyendo el aplazamiento CNDM «a la misma hora». El slot TEC 08:00–17:00 nunca es corroboración independiente de sí mismo. Las 08:00 fuera de ese slot siguen siendo válidas.
- Los aliases de apellido conservan spans, puntuación y contexto; no hay blacklist de personas. `programText` admite listas de repertorio; cada campo narrativo se examina por separado y exige atribución musical para apellidos aislados. Se mantienen las referencias «Obras de Iribarren», «Iribarren: Misa» y «Juan Francés de Iribarren».
- La categoría explícita de presentación de libro entra en la exclusión general de actividades no interpretativas. Una referencia secundaria a un libro no introduce esta exclusión por sí sola.

## Validación

- Base: **139 archivos / 2.651 unit tests** correctos.
- Rama: **139 archivos / 2.674 unit tests** correctos, incluidos golden determinista y golden con IA fake; unsafe publications **0**.
- `npm run check`: **0 errores, 0 warnings**, 2 hints preexistentes.
- `npm run build`: correcto, **931 páginas**.
- `node --import tsx src/cli/validate-data.ts`: catálogo válido.
- E2E local: servidor preview comprobado con `ASTRO_PREVIEW_BACKGROUND=1`; Playwright no encuentra su Chromium. La descarga desde el CDN devuelve un archivo inválido en este entorno. La verificación completa de E2E se realiza en el CI de la PR con Chrome del runner; su resultado se enlaza en la descripción de la PR.

Regresiones reproducibles:

```bash
npm test -- tests/ingestion-piumosso.test.ts tests/ingestion-reconcile.test.ts tests/ingestion-dates.test.ts tests/ingestion-cndm.test.ts tests/ingestion-knowledge.test.ts tests/ingestion-ateneo-madrid.test.ts tests/ingestion-golden-classify.test.ts tests/ingestion-golden-ai.test.ts
npm test
npm run check
npm run build
npm run test:e2e
```
