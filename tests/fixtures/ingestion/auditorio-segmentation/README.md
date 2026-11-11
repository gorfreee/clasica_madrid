# Auditorio: segmentación del programa

Capturas HTML oficiales del 22/10/2026: `h4` de `.content` y columna de información conservados; se omiten navegación, imagen y wrappers del layout. No son programas reconstruidos a partir de los datos saneados.

`run-observations.json` contiene literalmente las tres observaciones de `events.jsonl` del artifact **ingestion-run-39603845469-1** (run [39603845469](https://github.com/gorfreee/clasica_madrid/actions/runs/39603845469), commit `90cbea1923567b35e7e0d77c274f9ee109f784a9`). Conserva la interpretación anterior, incluidos los errores. Las pruebas comparan texto y elenco con ese registro y comprueban el nuevo resultado hasta candidato y reconciliación contra el catálogo saneado por #384.

| Fixture | Ficha oficial | Antes → esperado |
| --- | --- | --- |
| `patkop.html` | [CNDM. Patricia Kopatchinskaja & Fazil Say](https://auditorionacional.inaem.gob.es/es/programacion/cndm-patricia-kopatchinskaja-fazil-say-1) | 5 obras, PatKop como obra de Say y UniSolo de Say → 4 obras; UniSolo de PatKop |
| `requiem.html` | [OJEM. Requiem & Oberturas](https://auditorionacional.inaem.gob.es/es/programacion/orquesta-juvenil-europea-de-madrid-requiem-oberturas) | 2 obras → Requiem como única obra identificada; «& Oberturas» permanece en `programText` |
| `scheherazade.html` | [OJEM. Scheherazade & The Black Knight](https://auditorionacional.inaem.gob.es/es/programacion/orquesta-juvenil-europea-de-madrid-scheherazade-the-black-knight) | 4 obras → 2 obras con sus descriptores unidos |

Identidad acreditada de PatKop: la web de [Patricia Kopatchinskaja](https://www.patriciakopatchinskaja.com/list-of-works) titula su catálogo «PatKop Compositions», y el [CNDM](https://cndm.inaem.gob.es/node/23864) acredita UniSolo a Patricia Kopatchinskaja (1977), tanto en el programa como en el texto editorial. El parser conserva `PatKop (1977)` como observación; `knowledge/composers.ts` y la canonicalización compartida resuelven la identidad publicada. Su crédito como intérprete se conserva.

Las discrepancias de títulos, años y opus entre las fichas del Auditorio y del CNDM se mantienen tal como están en cada fuente: esta corrección trata segmentación y autoría, no decide cuál de esas ediciones del programa prevalece.
