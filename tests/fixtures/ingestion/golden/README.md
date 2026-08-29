# Golden evaluation set — Ingestion v3 Phase 2

Dataset de evaluación para la Classification Policy. **No es un classifier.** Phase 2 se implementará después contra estos casos.

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

## Composición

45 eventos reales, elegidos por diversidad (no al azar) a partir del workbook de smoke de Phase 1 y del catálogo publicado.

| Eligibility | Casos | Papel |
|---|---|---|
| `exclude` | 20 | Falsos positivos que Phase 1 publicaría hoy |
| `include` | 18 | Repertorio clásico, también cuando el título no lo dice |
| `uncertain` | 7 | Ficha insuficiente; no auto-publicar |

Fuentes representadas: Teatro Real, Auditorio Nacional / CNDM / Excelentia / OCNE, Fever, Teatros del Canal, Teatro de la Zarzuela, Basílica de Medinaceli, Museo Arqueológico Nacional, Madrid a Tempo, Ayuntamiento de Madrid, Real Hermandad del Refugio.

Formatos cubiertos: sinfónico, cámara, recital, órgano, ópera, zarzuela, coral, early-music, contemporánea, más exclusiones (pop, DJ, cine, danza, flamenco, jazz, taller).

## Cómo se obtuvieron los hechos

Consulta de las URLs oficiales enlazadas desde el smoke o el catálogo (2026-08-29). Se copió lo que la ficha declara: título, categoría, performers, programa, precios cuando aparecían.

No se usó conocimiento general para rellenar obras ausentes. Si la ficha no lista el programa, `composers`/`works` quedan vacíos y, si hace falta, `uncertain`.

HTML completo no se guarda: el golden set es la capa de *observed facts*. Fixtures HTML de parser viven en `../detail/` (pocos excerpts representativos por source). El pipeline de Phase 2.1 hidrata fichas y extrae hechos; todavía no ejecuta `golden.observed → classifier → golden.expected`.

## Datos deliberadamente unknown / vacíos

- `access=unknown` cuando no hay precio ni «gratuito»/«entrada libre».
- `eras=[]` cuando no hay obras ni compositores observables.
- `kind` omitido si el circuito no se puede decidir (p. ej. concierto parroquial sin ficha).
- No se asume iglesia=gratis, Auditorio=de pago, municipal=gratis.

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

## Qué no hace este dataset

- No implementa el classifier.
- No publica los ~134 eventos del sandbox.
- No llama a un LLM.
