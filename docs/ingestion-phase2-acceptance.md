# Acceptance de Ingestion v3 Phase 2

Ejecución real en dry-run de las tres sources actuales, **sin** `OPENAI_API_KEY` y **sin** LLM live. No se escribió `data/**`.

Esta prueba evalúa si Phase 2 es operable y observable. **No** implementa Phase 3 (reconciliation, updates, desapariciones, GitHub Actions ni auto-merge).

---

## 1. Baseline anterior (observability)

| | |
|---|---|
| Fecha | 2026-08-29 |
| Base | `origin/main` `7213049` (Phase 2.4 mergeada) |
| Commit probado | `0545f65` |
| Rama | `feat/ingestion-phase2-observability` |
| IA | no configurada (`ai.attempted = 0` en todas las ejecuciones) |
| Reports | `ingestion/reports/*.json` (gitignorados; no van a Git) |

### Resultado agregado (`ingest:sync --dry-run`)

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

Los tres dry-runs individuales sumaron el mismo total que `ingest:sync`. El report JSON por evento coincidió con el summary humano. `aiAttempted` es `false` en todas las filas.

### Por source (baseline)

**`auditorio-nacional`:** listing JSON FullCalendar, 111 RawEvents, hidratación 111/111, 0 structural skips, include / exclude / uncertain = 1 / 17 / 93. El único `include` (`OCNE. Sinfónico 01`, Mahler 2 + Urquiza) es correcto. Los 17 `exclude` encajaban con la política salvo el falso positivo de Chigi Codex. Los 93 `uncertain` son el comportamiento esperado sin IA.

**`teatro-real`:** listing HTML `/es/calendario`, 85 RawEvents, hidratación 85/85, 72 structural skips (53 fuera de ventana, **19 lugar no reconocido**), include / exclude / uncertain = 0 / 5 / 8. Los 5 `exclude` eran correctos (danza, cine, jazz). La ficha hidrata el espacio como `Sala Principal`, que no coincidía con el alias `teatro real`. Manon Lescaut, Bayreuth, *El Mesías*, Domingos de Cámara y recitals se descartaban **antes** de clasificar.

**`madrid-datos`:** JSON-LD municipal, 37 RawEvents `@type` Música, hidratación `not-requested`, **37/37 `lugar no reconocido`**, 0 clasificación. El parser funcionaba; el cuello de botella era el matching de venues municipales.

### Problemas encontrados en el baseline

1. Hydration de fichas sana en Auditorio y Teatro Real (0 failures).
2. La puerta de publicación se cumple: sólo `include` genera Candidate; dry-run no escribe catálogo.
3. Sin IA, el recall de `include` es deliberadamente bajo. No se relajaron reglas.
4. **Falso positivo de `exclude`:** `OCNE. Satélite 08. Chigi Codex` caía en `flamenco-identity` por «compositores flamencos del Códice de Chigi» (escuela franco-flamenca). Un `exclude` determinista no llega al fallback de IA.
5. Falsos negativos de `exclude` (quedan `uncertain`): `CNDM. Myra Melford…` (jazz); varios `¿Te suena…?` (taller). Siguen sin publicarse.
6. **Matching de venue del Teatro Real (`Sala Principal`)** era el bloqueo operativo más serio. No es un venue nuevo: es el recinto ya publicado.
7. **Madrid Datos** no aportaba candidatos hasta reconocer centros municipales. Mezcla clásica y no clásica; el skip estructural evitaba falsos positivos, pero también impedía clasificar.

Conclusión de entonces: pipeline operable, **no** lista para publicación automática desatendida mientras Sala Principal, el falso flamenco y Madrid Datos 37/37 skip siguieran abiertos.

---

## 2. Fixes aplicados (esta PR de estabilización)

Rama `feat/ingestion-phase2-stabilization`, sobre `origin/main` posterior al rebaseline editorial (`7ada5db`). **No** se implementa Phase 3.

### A. Teatro Real / `Sala Principal`

Resolución **source-aware** en `matchVenue`, no un alias global:

`sourceId=teatro-real` + `venueText="Sala Principal"` → `ven_teatro_real`.

La misma cadena desde `madrid-datos` o `auditorio-nacional` no resuelve. Los aliases globales existentes (`teatro real`, `sala sinfonica`, `sala de camara`, `real teatro de retiro`, …) siguen igual. Las salas del Real Junior (`SALA PRINCIPAL Real Teatro de Retiro`, `HALL…`, `SALA PACÍFICO…`) apuntan al Retiro, no al coliseo.

### B. Flamenco vs franco-flamenco

La regla `flamenco-identity` exige identidad de **flamenco musical** (Paco de Lucía, zambomba, jóvenes flamencos, guitarra flamenca, palos, recital/gala de flamenco, `cante` en el rol). Los contextos musicológicos (franco-flamenco, escuela/polifonía flamenca, compositores flamencos renacentistas, Códice de Chigi) se enmascaran antes de tratar `flamenc*` como exclusión. No se ha desactivado la keyword ni se ha hecho una excepción por event ID.

### C. Madrid Datos — estrategia de venue

La fuente expone, además del nombre (`event-location`):

- `relation.@id` → instalación municipal estable (`…/entidadesyorganismos/{id}-….json`);
- dirección estructurada (`street-address`, `postal-code`);
- `organization-name` (suele repetir el nombre del centro).

**Qué se ha implementado (determinista, precisión > cobertura):**

1. Extraer el facility id numérico; no se copia a `ObservedFacts`.
2. Mapa source-specific facility id → venue **ya publicado** (Casa de Vacas `1945`, Jardín Peña Gorbea `5978923`, Parque Lineal de Palomeras `5977748`).
3. Nombre exacto contra catálogo / aliases globales.
4. En `madrid-datos` únicamente: quitar un sufijo final `(Distrito)` y volver a exigir match exacto (`Centro Cultural Casa de Vacas (Retiro)` → `Centro Cultural Casa de Vacas`).
5. Variante explícita `Jardín del Bulevar de Peña Gorbea` → el jardín ya publicado.

**Qué no se ha hecho (a propósito):**

- No hay fuzzy matching global ni «nombres parecidos».
- No se crea un venue nuevo por cada instalación municipal (serían centros generalistas: Cineteca, CentroCentro, bibliotecas, CondeDuque como *centro* ≠ auditorio canónico).
- El facility id `1916` (Centro de Cultura Contemporánea CondeDuque) **no** se mapea a `ven_condeduque_auditorio`.
- La dirección municipal no se usa para igualar: el texto (`PASEO COLOMBIA 1`) no es la dirección canónica y no se inventa.

Los no resolubles siguen `lugar no reconocido`. Follow-up posible (no Phase 3 de reconciliation general): ir añadiendo facility ids / aliases cuando un centro municipal coincida de forma inequívoca con un venue publicado; crear venues nuevos sólo con identidad estructurada *y* decisión editorial de que el espacio pertenece al catálogo.

---

## 3. Nueva ejecución

| | |
|---|---|
| Fecha | 2026-08-29 |
| Base | `origin/main` `7ada5db` (rebaseline editorial) |
| Rama | `feat/ingestion-phase2-stabilization` |
| IA | no configurada (`ai.attempted = 0`) |
| Reports | `ingestion/reports/*.json` (gitignorados) |

Mismos comandos que el baseline, sin `OPENAI_API_KEY`:

```bash
npm run ingest:source -- auditorio-nacional --dry-run --report ingestion/reports/auditorio-nacional.json
npm run ingest:source -- teatro-real --dry-run --report ingestion/reports/teatro-real.json
npm run ingest:source -- madrid-datos --dry-run --report ingestion/reports/madrid-datos.json
npm run ingest:sync -- --dry-run --report ingestion/reports/sync.json
```

### Resultado agregado (`ingest:sync --dry-run`)

| Métrica | Baseline | Ahora |
|---|---|---|
| Fuentes correctas / fallidas | 3 / 0 | 3 / 0 |
| RawEvents | 233 | 233 |
| Hidratación intentada / correcta / fallida | 196 / 196 / 0 | 196 / 196 / 0 |
| include | 1 | 10 |
| exclude | 22 | 27 |
| uncertain | 101 | 117 |
| Descarte estructural | 109 | 79 |
| Candidatos | 1 (existing) | 10 (4 existing + 6 new; 0 escritos) |
| `data/**` modificado | no | no |

Los tres dry-runs individuales vuelven a sumar el mismo total que `ingest:sync`. `aiAttempted` sigue `false`. No se relajaron reglas de clasificación para inflar métricas: los `include` nuevos salen de eventos que **antes ni llegaban** al classifier.

### Por source (ahora)

#### `auditorio-nacional`

| | Baseline | Ahora |
|---|---|---|
| RawEvents / hidratación | 111 / 111 | 111 / 111 |
| Structural skips | 0 | 0 |
| include / exclude / uncertain | 1 / 17 / 93 | 1 / 16 / 94 |
| Candidatos | 1 existing | 1 existing |

El `include` sigue siendo sólo `OCNE. Sinfónico 01`. Los `exclude` de flamenco musical que quedan: *Zambomba Flamenca de Jerez*, *Jóvenes Flamencos*, *Paco de Lucía*. **Chigi Codex ya no está entre ellos.**

#### `teatro-real`

| | Baseline | Ahora |
|---|---|---|
| RawEvents / hidratación | 85 / 85 | 85 / 85 |
| Structural skips | 72 (53 ventana + **19 lugar**) | **53 (solo fuera de ventana)** |
| include / exclude / uncertain | 0 / 5 / 8 | 9 / 9 / 14 |
| Candidatos | 0 | 9 (3 existing + 6 new) |

Los **19 skips por lugar no reconocido desaparecen todos**. Los 53 restantes son temporada fuera de la ventana de 120 días, igual que antes.

Eventos que ahora **llegan a classification** (antes `lugar no reconocido`), con resultado:

| Evento | Ahora |
|---|---|
| Manon Lescaut | `include` (ópera, existing) |
| Preestreno Joven Manon Lescaut | `include` (ópera, existing) |
| El Mesías | `include` (ópera, new) |
| Gira Bayreuth | `uncertain` (existing; sin programa extraído bastante fuerte para include determinista) |
| Domingos de Cámara I | `include` (serie de cámara, existing) |
| Domingos de Cámara II | `include` (new) |
| Domingos de Cámara V 25-26 | `uncertain` (existing) |
| Riccardo Primo | `include` (ópera, new) |
| Simon Boccanegra | `include` (ópera, new) |
| Las bodas de Fígaro | `include` (ópera, new) |
| El castillo de Barbazul | `include` (ópera, new) |
| Véronique Gens / Xabier Anduaga | `uncertain` (recitales; golden `include` con ficha más rica que el haystack live) |
| CONCIERTO DE NAVIDAD / Jeanette | `exclude` popular (correcto) |
| DJ Symphonic | `exclude` dj (correcto) |
| Alvin Ailey | `exclude` (no se publica; el `ruleId` live es `jazz-identity` por el texto de ficha, no un mapeo de venue erróneo) |
| Fito Páez / Pastora Soler | `uncertain` (golden `exclude`; siguen sin publicarse) |

No se ha visto un mapeo de venue incorrecto: `Sala Principal` del coliseo va a `ven_teatro_real`; las funciones Real Junior que ya resolvían al Retiro siguen haciéndolo. `Sala Principal` no se ha convertido en alias global.

#### `madrid-datos`

| | Baseline | Ahora |
|---|---|---|
| RawEvents | 37 | 37 |
| Hidratación | not-requested | not-requested |
| Venues resueltos (llegan a classification) | 0 | **11** |
| Structural skip | 37 | **26** |
| include / exclude / uncertain | 0 / 0 / 0 | 0 / 2 / 9 |
| Candidatos | 0 | 0 |

Los 11 resueltos son todos de **Casa de Vacas** (facility `1945` + nombre con `(Retiro)`). Entran a classification: `II Festival Internacional de Piano`, `Festival Alicia de Larrocha`, `Recital de piano`, y el resto de la programación de ese centro (pop, copla, etc.). Exclude: `Pop` (popular) y `Festival 4 estaciones` (flamenco musical en esa ficha). Ningún `include` sin IA, coherente con precisión > cobertura.

Los **26** que siguen skip son instalaciones municipales **sin** venue canónico ni facility map, p. ej.:

| Ejemplo | Por qué no se resuelve |
|---|---|
| *Bach en guitarra*, *Tade de Jazz* | Centro Cultural Buenavista (Salamanca) — centro de distrito, no está en el catálogo |
| *Concierto de música renacentista* | Biblioteca Miguel Delibes — no hay venue publicado |
| *Lê Quan Ninh*, *Senyawa*, *RAGE Thormbones* | CentroCentro — no se crea un venue generalista |
| *L.E.V. 2026…* | Centro Danza Matadero — no está en el catálogo |
| *Poesía, tango y flamenco* | Centro Cultural Lope de Vega — no está en el catálogo |
| Centro de Cultura Contemporánea CondeDuque | **ambiguo a propósito**: no es el auditorio `ven_condeduque_auditorio` (en esta corrida no había música allí; el test de fixture cubre el no-mapeo) |

Eso es un *safe failure*, no un falso positivo de publicación.

---

## 4. Comparación before / after (lo que importaba)

| Problema del baseline | ¿Resuelto? |
|---|---|
| 19 skips Teatro Real por `Sala Principal` | Sí: 19 → 0. Manon, Mesías, Cámara, Bayreuth, recitals clasifican. |
| Mapeo incorrecto Sala Principal | No observado. Source-aware; otra source no resuelve. |
| Chigi Codex `exclude` flamenco | Sí: ahora `uncertain` (`ai-unavailable` / evidencia insuficiente). No es `exclude`. Los flamencos musicales siguen `exclude`. |
| Madrid Datos 37/37 skip | Parcial y deliberado: 11/37 resueltos (Casa de Vacas). 26 siguen skip con identidad insuficiente. No se han inventado 26 venues. |

---

## 5. Problemas que todavía quedan

1. **Sin IA, casi todo el clásico institucional sigue `uncertain`** (Bach Brandeburgo, Réquiem, Casals, Bayreuth, Gens, Anduaga, recitales de Casa de Vacas…). Aceptable para precisión; la cobertura de `include` no es un objetivo de esta PR. Acceptance con `OPENAI_API_KEY` real es una corrida aparte.
2. **Falsos negativos de `exclude`:** `¿Te suena…?` y Fito/Pastora pueden quedar `uncertain` en live (ficha vs golden). No se publican.
3. **Alvin Ailey** se excluye, pero el `ruleId` live no es `dance-spectacle`. No publica. Follow-up de classifier, no de venues.
4. **Madrid Datos:** la mayoría de centros de distrito / bibliotecas / CentroCentro no tienen entidad canónica. Estrategia sostenible = ir mapeando facility ids inequívocos; **no** auto-crear venues. Un concierto clásico en Buenavista o en una biblioteca seguirá skip hasta ese mapeo editorial.
5. **Phase 3** (updates de eventos existentes, reconciliation/fuzzy, desapariciones, GitHub Actions de ingestión, auto-merge) sigue fuera de alcance. Bayreuth `existing` + `uncertain` no se reescribe; Manon `existing` + `include` genera Candidate pero dry-run no actualiza el JSON publicado.

Ninguno de estos es un fallo grave de resolución ni un `exclude` determinista con falso positivo conocido grave.

---

## 6. ¿Phase 2 está técnicamente suficientemente estable para empezar Phase 3?

**Sí.** Las tres sources principales son operables (listing no vacío, hidratación 100 % en Auditorio y Teatro Real, Madrid Datos parsea JSON-LD). El matching de `Sala Principal` ya no tira eventos del coliseo. El `exclude` de flamenco ya no tumba un Códice renacentista. Madrid Datos tiene una estrategia de resolución repetible (facility id + nombre exacto / sufijo de distrito) y deja el resto como skip seguro. La puerta de publicación no se ha relajado. Dry-run no toca `data/**`.

No hace falta cobertura perfecta. Los gaps restantes están entendidos y son *safe failures* (uncertain, skip estructural, exclude correcto).

Sigue **sin** ser publicación automática desatendida: hace falta el acceptance con IA real y, para catálogo vivo, el trabajo de Phase 3 (updates, reconciliation, cadencia). Eso no bloquea *empezar* Phase 3.
