# Acceptance de Ingestion v3 Phase 2

Ejecución real en dry-run de las tres sources actuales, **sin** `OPENAI_API_KEY` y **sin** LLM live. No se escribió `data/**`.

Esta prueba evalúa si Phase 2 es operable y observable. **No** implementa Phase 3 (reconciliation, updates, desapariciones, GitHub Actions ni auto-merge).

## Metadatos

| | |
|---|---|
| Fecha | 2026-08-29 |
| Base | `origin/main` `7213049` (Phase 2.4 mergeada) |
| Rama | `feat/ingestion-phase2-observability` |
| IA | no configurada (`ai.attempted = 0` en todas las ejecuciones) |
| Reports | `ingestion/reports/*.json` (gitignorados; no van a Git) |

## Resultado agregado (`ingest:sync --dry-run`)

| Métrica | Valor |
|---|---|
| Fuentes intentadas | 3 (`auditorio-nacional`, `teatro-real`, `madrid-datos`) |
| Fuentes correctas | 3 |
| Fuentes fallidas | 0 |
| RawEvents | 233 |
| Hidratación intentada / correcta / fallida | 196 / 196 / 0 |
| include | 1 |
| exclude | 22 |
| uncertain | 101 |
| Descarte estructural | 109 |
| Candidatos | 1 (ya existente; 0 escritos) |
| `data/**` modificado | no |

Los tres dry-runs individuales suman el mismo total que `ingest:sync`. El report JSON por evento coincide con el summary humano. `aiAttempted` es `false` en todas las filas.

## Por source

### `auditorio-nacional`

| | |
|---|---|
| Listing | JSON FullCalendar parseado; 111 RawEvents; URLs de ficha `auditorionacional.inaem.gob.es/es/programacion/…` |
| Extracción vacía | no |
| Hidratación | 111/111 (100 %) |
| Structural skips | 0 |
| include / exclude / uncertain | 1 / 17 / 93 |
| Candidatos | 1 (`OCNE. Sinfónico 01`, `identity=existing`) |

El único `include` es correcto: Mahler 2 + Urquiza, `formats=symphonic`, `eras=romantic+contemporary`, `kind=established`, `access=paid`. Coincide con `golden_ocne_sinfonico_01`.

Los 17 `exclude` encajan con la política: flamenco (zambomba, jóvenes flamencos, Paco de Lucía), cine/film symphony, pop (ABBA/Queen/Beatles, gala de Navidad popular), DJ, jazz, Red Bull.

Los 93 `uncertain` son el comportamiento esperado **sin IA**: títulos con repertorio clásico evidente (Bach Brandeburgo, Réquiem de Mozart, Cuarteto Casals, Les Musiciens du Louvre, OCNE Sinfónico 02, etc.) no llegan a `include` si el classifier determinista no extrae compositores/obras con bastante seguridad. Precisión > cobertura: no se publican.

### `teatro-real`

| | |
|---|---|
| Listing | HTML `/es/calendario` parseado; 85 RawEvents; URLs `/es/espectaculo/…` |
| Extracción vacía | no |
| Hidratación | 85/85 (100 %) |
| Structural skips | 72 (53 fuera de ventana, 19 lugar no reconocido) |
| include / exclude / uncertain | 0 / 5 / 8 |
| Candidatos | 0 |

Los 5 `exclude` son correctos: *El Cascanueces* (danza), cine junior/Cineclásica, Miniclásica jazz.

Los 8 `uncertain` incluyen casos golden coherentes (`sarao_barroco`, `navidad_canciones`) y tres `¿Te suena…?` que el golden marca `exclude` (taller) y aquí quedan `uncertain`.

**Pérdida de cobertura importante:** la ficha hidrata el espacio como `Sala Principal`, que no coincide con el alias `teatro real`. Eventos de septiembre en el propio Teatro Real — Manon Lescaut, Bayreuth, *El Mesías*, Domingos de Cámara, recitals — se descartan como `lugar no reconocido` **antes** de clasificar. No se han añadido venues ni aliases en esta tarea.

Los 53 `fuera de ventana` son sobre todo temporada 2026–27 más allá de 120 días (ópera de 2027, etc.). Eso es la ventana, no un fallo de parser.

### `madrid-datos`

| | |
|---|---|
| Listing | JSON-LD municipal; 37 RawEvents `@type` Música con fecha, hora y lugar |
| Hidratación | `not-requested` (37), como está diseñado |
| Structural skips | 37/37 `lugar no reconocido` |
| include / exclude / uncertain | 0 / 0 / 0 |
| Candidatos | 0 |

El JSON-LD se parsea. El cuello de botella es el matching de venues municipales, no la extracción. Hay títulos que merecerían clasificación si el lugar se reconociera (`Concierto de música renacentista`, `Bach en guitarra`, `II Festival Internacional de Piano`, `Festival Alicia de Larrocha`, `Recital de piano`) mezclados con jazz, copla, pop y Lip Sync. No se han dado de alta venues nuevos.

## Hallazgos relevantes

1. **Hydration de fichas está sana** en Auditorio y Teatro Real (0 failures, 0 patrones sistemáticos de 404/HTML inesperado en esta corrida).
2. **La puerta de publicación se cumple:** sólo un `include` genera Candidate; dry-run no escribe catálogo.
3. **Sin IA, el recall de `include` es deliberadamente bajo.** No se han relajado reglas por el volumen de `uncertain`.
4. **Falso positivo de `exclude`:** `OCNE. Satélite 08. Chigi Codex` cae en `flamenco-identity` porque la ficha dice «compositores **flamencos** del Códice de Chigi» (escuela franco-flamenca, no flamenco). No se ha cambiado la regla en esta PR.
5. **Falsos negativos de `exclude` (quedan `uncertain`):** `CNDM. Myra Melford’s Fire And Water Quintet` (golden `exclude`, jazz); varios `¿Te suena…?` del Teatro Real (golden `exclude`, taller). Siguen sin publicarse.
6. **Matching de venue del Teatro Real** (`Sala Principal`) es el bloqueo operativo más serio para Phase 3. No es un venue nuevo: es un alias del recinto ya publicado.
7. **Madrid Datos** no aporta candidatos hasta que existan aliases de centros culturales / distritos. Mezcla clásica y no clásica; el skip estructural evita falsos positivos municipales.

## ¿Phase 2 parece estable?

**Sí, como pipeline de harvesting + classification + publication gate.** Las tres sources responden, el listing no sale vacío de forma sospechosa, la hidratación no se cae, el classifier no inventa `include`, y dry-run no toca `data/**`.

**No está lista para publicación automática desatendida** mientras:

- Teatro Real pierda Manon/Bayreuth/Mesías por `Sala Principal`;
- un Códice renacentista pueda marcarse flamenco;
- casi todo el clásico institucional quede `uncertain` sin IA (aceptable para precisión, insuficiente para cobertura).

Esos puntos son trabajo posterior (aliases, regla flamenco/flamenco-vs-Flemish, opcionalmente IA). No son Phase 3.
