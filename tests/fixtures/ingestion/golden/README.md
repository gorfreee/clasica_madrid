# Golden evaluation set — Ingestion v3 Phase 2

Dataset de evaluación para la Classification Policy. Phase 2.2 ejecuta `golden.observed → classify()` sobre estos casos. Phase 2.3 evalúa el mismo set con un fake de IA cuando el determinista deja `uncertain`. **No es una tabla de lookup:** las reglas deterministas deben ser generales. El fake de IA de tests no es un modelo real.

Política: [`docs/classification-policy.md`](../../../docs/classification-policy.md).

## Forma de cada caso

```text
listingTitle     → lo que vería el harvest de listado
observed         → hechos de la ficha oficial (no inventados)
expected         → eligibility / formats / eras / kind / access
reason           → por qué
missingEvidence  → obligatorio si eligibility=uncertain
```

`eligibility` es metadata interna. No es un campo del schema canónico `Event`.

Sólo `include` es publicable automáticamente.

Si `expected.eligibility === include`, `kind` debe estar resuelto (`established` o `alternative`). Si el caso no tiene evidencia clara de circuito established, `expected.kind = alternative`. `kind` puede omitirse en `exclude`/`uncertain` porque el classifier hace short-circuit.

## Composición

45 eventos reales, elegidos por diversidad (no al azar) a partir del workbook de smoke de Phase 1 y del catálogo publicado. El rebaseline editorial de 2026-08-29 añadió casos de eventos mixtos, ciclo clásico sin programa, contemporánea concertística y actividades participativas.

| Eligibility | Casos | Papel |
|---|---|---|
| `exclude` | 21 | Falsos positivos que Phase 1 publicaría hoy |
| `include` | 23 | Repertorio clásico, también cuando el título no lo dice |
| `uncertain` | 4 | Ficha insuficiente; no auto-publicar |

Fuentes representadas: Teatro Real, Auditorio Nacional / CNDM / Excelentia / OCNE, Fever, Teatros del Canal, Teatro de la Zarzuela, Basílica de Medinaceli, Museo Arqueológico Nacional, Madrid a Tempo, Ayuntamiento de Madrid, Real Hermandad del Refugio.

Formatos cubiertos: sinfónico, cámara, recital, órgano, ópera, zarzuela, coral, early-music, contemporánea, más exclusiones (pop, DJ, cine, danza, flamenco, jazz, taller).

## Cómo se obtuvieron los hechos

Consulta de las URLs oficiales enlazadas desde el smoke o el catálogo (2026-08-29). Se copió lo que la ficha declara: título, categoría, performers, programa, precios cuando aparecían.

No se usó conocimiento general para rellenar obras ausentes. Si la ficha no lista el programa, `composers`/`works` quedan vacíos y, si hace falta, `uncertain`.

HTML completo no se guarda: el golden set es la capa de *observed facts*. Fixtures HTML de parser viven en `../detail/` (pocos excerpts representativos por source). Phase 2.1 hidrata fichas. Phase 2.2 clasifica esos hechos. Phase 2.3 añade fallback de IA (tests con fake; CI no llama a un LLM). Phase 2.4 conecta el classifier al pipeline como puerta de publicación: expected exclude/uncertain nunca llegan a Candidate.

## Datos deliberadamente unknown / vacíos

- `access=unknown` cuando no hay precio ni «gratuito»/«entrada libre» en `accessText`. No se asume iglesia=gratis, Auditorio=de pago, Fever=paid, municipal=gratis.
- `eras=[]` cuando no hay obras ni compositores observables.
- `kind` omitido si eligibility no es `include` y el circuito no se puede decidir (p. ej. concierto parroquial sin ficha).
- Para `include` sin evidencia established, `kind=alternative`.

## Trampas de título (ficha ≠ listado)

| Caso | El título sugería | La ficha demostró |
|---|---|---|
| `golden_concierto_navidad_teatro_real` | concierto clásico / uncertain | gala popular (Lennon, Sinatra, Feliciano) → `exclude` |
| `golden_upm_navidad` | gala genérica de Navidad | Oratorio de Navidad de Bach → `include` |
| `golden_ocne_sinfonico_01` | código interno, sin repertorio | Mahler 2 + Urquiza → `include` |
| `golden_xabier_anduaga` / `golden_veronique_gens` | sólo el intérprete | arias de ópera / barroco francés → `include` |
| `golden_dj_delica_vivaldi` | Vivaldi | producto DJ/crossover → `exclude` |
| `golden_sarao_barroco` | música antigua | Barroco **y** flamenco coprincipales → `uncertain` |
| `golden_fito_paez` | «Clásico» en el Teatro Real | canción popular con cuerdas → `exclude` |
| `golden_raices_sinfonicas` | fiesta canaria / folklore | bloque clásico autónomo (Saint-Saëns, Falla) en concierto sinfónico → `include` |
| `golden_madrid_tempo_open_piano` | festival de piano | open piano participativo, sin concierto programado → `exclude` |
| `golden_domingos_camara_i` | título de ciclo sin obras | serie de conciertos de cámara de solistas de orquesta → `include` |

## Qué no hace este dataset

- No publica los ~134 eventos del sandbox.
- No llama a un LLM.
- No es un lookup `caseId → resultado`.
