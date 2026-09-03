# Classification Policy v1

Política editorial para el enrichment de ingestión. No es un campo del schema canónico `Event`.

La elegibilidad es metadata interna del pipeline. `formats`, `eras`, `kind` y `access` sí son campos canónicos; esta política dice cómo derivarlos. La implementación vive en `src/ingestion/classification/`. El golden set en `tests/fixtures/ingestion/golden/` es la medida.

## Principio

```text
precision > coverage
observed facts → deterministic rules → musical knowledge → AI → safe uncertain
```

Preferimos perder temporalmente un evento antes que publicar un falso positivo.

Un `include` o `exclude` determinista no se reabre con IA para eligibility. El fallback de IA sólo actúa sobre `uncertain` para decidir include/exclude. Si el resultado final es `include` y `eras`/`formats` siguen sin resolver, la IA puede completar esos campos; no puede cambiar eligibility ni `access`. Si esa llamada falla, el evento sigue `include`.

## Separación de responsabilidades

```text
listing harvest
      ↓
detail-page hydration / observed facts
      ↓
eligibility          ← puerta de publicación
      ↓
formats / eras / kind / access
      ↓
Candidate
```

Un `exclude` no debe consumir clasificación posterior. Un `uncertain` no se publica automáticamente.

## Lo que no es esta política

```text
eligibility ≠ format
eligibility ≠ kind
eligibility ≠ source
eligibility ≠ venue
```

- `format=symphonic` no implica música clásica. ABBA con orquesta puede ser `symphonic` y `exclude`.
- `kind=established` no implica música clásica. Un concierto de pop en el Teatro Real puede ser `established` y `exclude`.
- Venir del Teatro Real, del Auditorio Nacional o del CNDM no implica inclusión.
- Una agenda municipal no implica exclusión.

La decisión se basa principalmente en **qué repertorio se interpreta y cuál es la naturaleza musical real del evento**.

La presencia de orquesta, instrumentos clásicos, sala clásica, músicos de formación clásica o arreglos sinfónicos **no convierte** un evento en música clásica.

---

## 1. Eligibility (tri-state interno)

| Valor | Semántica | ¿Publicable automáticamente? |
|---|---|---|
| `include` | Hay evidencia suficiente de que el evento pertenece al ámbito de Clásica Madrid | sí, si el resto de datos esenciales es válido |
| `exclude` | Hay evidencia suficiente de que está fuera | no |
| `uncertain` | La evidencia no permite decidir con seguridad | no |

`uncertain` no es un sí débil. Es un no a la publicación automática.

### 1.1 Ámbito musical

Clásica Madrid incluye eventos cuyo contenido musical principal sea **música clásica occidental**, en sentido amplio: música antigua, Renacimiento, Barroco, Clasicismo, Romanticismo, repertorio de los siglos XX y XXI del ámbito clásico, y creación contemporánea de tradición clásica / académica.

Formatos habituales de inclusión, si el repertorio encaja: concierto sinfónico, coral clásico, cámara, recital instrumental o vocal clásico, ópera, zarzuela, música antigua, órgano, ensemble especializado, conciertos contemporáneos del ámbito clásico, programas explícitos de compositores clásicos.

La música **instrumental contemporánea o neoclásica** dentro de la tradición concertística —por ejemplo, repertorio de piano interpretado como recital— puede quedar dentro del ámbito. La popularidad o el carácter comercial del compositor o del producto **no** son criterio de exclusión. Siguen fuera cuando la identidad principal sea música de cine, pop/rock u otro crossover.

No clasificar **solo** por palabras del título si existe ficha de detalle.

### 1.2 Exclusiones decididas

Excluir cuando la identidad principal del evento sea una de estas:

**Pop / rock / canción / música popular** arreglada para ensemble clásico. Orquesta, coro o cuerdas no cambian la decisión. Ejemplos: Fito Páez con cuerdas; ABBA, Queen o Beatles con orquesta; Pastora Soler; Jeanette; homenajes pop sinfónicos.

**DJ / electrónica / crossover** cuyo repertorio principal no sea clásico, o cuya identidad sea el formato DJ aunque cite una obra clásica. Ejemplos: DJ Symphonic; Red Bull Symphonic; DJ + Vivaldi como producto crossover.

**Música de cine** como contenido principal: John Williams, Hans Zimmer, Morricone, Film Symphony Orchestra, galas de bandas sonoras. Aunque la música sea orquestal.

**Jazz**, salvo que el evento sea realmente un programa de música clásica y el jazz sea únicamente secundario. Un concierto cuya identidad principal sea jazz → `exclude`. Incluye ciclos institucionales de jazz (p. ej. CNDM «Jazz en el Auditorio»).

**Flamenco**, incluidos homenajes a Paco de Lucía, jóvenes flamencos, zambombas, etc.

No excluir por la palabra *flamenco* cuando el contexto es claramente musicológico / histórico (escuela **franco-flamenca**, polifonía flamenca, compositores flamencos renacentistas, Códice de Chigi). En ese uso «flamenco» significa Flemish, no el género musical español. Si hay duda entre las dos lecturas, `uncertain` es preferible a un `exclude` determinista: ese `exclude` no llega al fallback de IA.

**Danza**: espectáculos de danza, incluso con repertorio clásico. Ballet, Alvin Ailey, *El Cascanueces* como representación de danza. La agenda es de eventos musicales, no de artes escénicas en general.

**Cine / proyecciones**: películas, cine familiar, cine mudo con acompañamiento, ciclos cuya actividad principal sea ver una película. Si excepcionalmente la componente principal es una **interpretación musical clásica en directo**, no asumir exclusión automática: evaluar el detalle.

**Talleres / actividades educativas no interpretativas**: talleres, encuentros, charlas, conferencias, actividades paralelas, actividades infantiles tipo taller. Ejemplo: `¿Te suena Manon Lescaut?`. Un concierto real con mediación (p. ej. OCNE «Descubre» con narradora y repertorio clásico) **sí** puede ser `include`: la actividad principal sigue siendo el concierto.

**Actividades participativas sin concierto programado**: poner un instrumento a disposición del público, jam participativa, open piano u otras sesiones donde no hay una interpretación concertística anunciada. No se publican como eventos de la agenda. Un recital o concierto real del mismo festival o ciclo se evalúa aparte.

**Otros no musicales / no interpretativos**: exposiciones, visitas, teatro de objetos, coloquios, actos culturales sin interpretación de repertorio clásico.

### 1.3 Títulos que exigen ficha

No decidir por el título solo cuando sea genérico, poético, un código interno o un nombre de intérprete sin programa: Concierto de Navidad / Gala de Navidad; Concierto extraordinario / aniversario; `OCNE Sinfónico 01`; títulos puramente poéticos; nombres de intérpretes sin programa.

Tras consultar las fuentes oficiales, si el repertorio queda claro, decidir `include` o `exclude`. Si sigue sin haber evidencia suficiente → `uncertain`.

Un título que *parece* clásico puede ser un gala popular. Un título que *parece* genérico puede ser Mahler. La ficha manda.

Una declaración explícita y fiable de que **ese evento** es un concierto de música clásica (p. ej. «Concierto de música clásica española») puede ser evidencia suficiente para `include`, aunque no haya programa obra-por-obra. Eso no es `venue clásico → include` ni `source clásica → include`, ni basta un título ambiguo.

La ausencia de programa obra-por-obra **no** obliga siempre a `uncertain`. Un concierto puede tener evidencia suficiente para `include` cuando la fuente oficial demuestra de forma clara que:

- se trata de un concierto real (no un taller, jam, open piano ni otra actividad no interpretativa);
- pertenece a un festival o ciclo explícitamente de música clásica; o
- está interpretado por una formación clásica dentro de una serie cuya identidad clásica está suficientemente establecida.

Eso es evidencia válida sobre **ese evento**. No es una regla automática por source ni por venue. Un mismo ciclo puede contener actividades excluidas: cada evento se evalúa individualmente.

### 1.4 Eventos mixtos

Un evento mixto puede ser `include` si contiene un **bloque clásico sustancial, autónomo e identificable** y el evento global se presenta genuinamente como concierto musical clásico o sinfónico.

Debe seguir siendo `exclude` cuando lo clásico sea principalmente acompañamiento, arreglo, ornamentación o formato instrumental de una identidad predominantemente pop/rock, canción popular, jazz, flamenco, música de cine, crossover, DJ/electrónica u otra categoría expresamente excluida.

La presencia de orquesta, de un piano o de un compositor clásico aislado **no** convierte en `include` un homenaje pop, un tributo de cine o un espectáculo crossover.

Ejemplos:

- `include`: concierto sinfónico real con una primera parte de repertorio clásico autónomo (obras de concierto, solista y orquesta) y una segunda parte de repertorio popular o regional. También cuando lo clásico es claramente principal.
- `exclude`: ABBA, Queen o Beatles con orquesta; Fito Páez con cuerdas; tributo a Hans Zimmer o Morricone; pop anunciado como «de clásico a lo pop»; musical de Broadway con orquesta; espectáculo de humor/crossover que parodia un recital; flamenco donde lo clásico es accesorio.
- coprincipales (p. ej. barroco y flamenco en el mismo programa): nunca `exclude` automático. `include` sólo si los hechos observados demuestran un bloque clásico sustancial, autónomo e identificable; si no, `uncertain`.

---

## 2. Hechos observados vs inferencias

**Hechos observados** (el adapter o la hidratación de detalle los extrae; no se inventan): título, descripción, categoría oficial, fechas, lugar, URL; performers, composers, works, programa, cuando la fuente los declara; texto de acceso, cuando existe.

**Inferencias** (enrichment): `eligibility`; `formats`, `eras`, `kind`; `access` sólo si el texto de la fuente lo soporta; roles canónicos de intérprete, cuando el texto lo permite con seguridad.

La knowledge base puede asociar `Bach → baroque`. No puede afirmar que Beethoven participa en un programa donde la fuente no lo menciona.

CI y tests no deben depender de llamadas live a un LLM. Si la IA no está disponible, hace timeout o devuelve algo inválido, el pipeline degrada: reglas y knowledge si bastan; si no, `uncertain` / campos vacíos.

---

## 3. `formats[]`

Taxonomía: `src/lib/schemas/taxonomies.ts`. Pueden ser múltiples. Vacío es mejor que incorrecto. Un `format` incorrecto no debe bloquear un `include` fiable.

Derivación preferida a partir de hechos:

| Hecho | Format típico |
|---|---|
| orquesta sinfónica protagonista | `symphonic` |
| solista solo (piano, violín, canto con piano, etc.) | `recital` |
| cuarteto / octeto / ensemble de cámara | `chamber` |
| coro protagonista | `choral` |
| órgano | `organ` (a menudo + `recital`) |
| ópera | `opera` |
| zarzuela | `zarzuela` |
| Lied / mélodie con canto y piano | `lied` + `recital` |
| música antigua / historicamente informada | `early-music` (combinable) |
| coro + orquesta | `choral` + `symphonic` |
| identidad no encaja o es híbrida no clasificable | `other` o vacío |

`early-music` describe práctica/repertorio antiguo, no sustituye a `eligibility`.

---

## 4. `eras[]`

Taxonomía: `src/lib/schemas/taxonomies.ts`. Pueden ser múltiples. Vacío es mejor que incorrecto. No bloquean publicación si `eligibility=include`.

Orden de evidencia:

1. obras identificadas;
2. si no hay obras, compositores declarados por la fuente;
3. si no hay arrays estructurados, `programText` (o la descripción) cuando nombra explícitamente compositores u obras conocidos;
4. si no hay ninguna de esas evidencias, vacío. No deducir época por el nombre del ensemble, del ciclo o del venue.

Ejemplo: Bach + Mozart + Mahler → `baroque` + `classical` + `romantic`.

### Frontera `twentieth` / `contemporary`

El schema no define fechas. Criterio operativo v1 (conservador):

- **`twentieth`**: repertorio de tradición clásica/académica del siglo XX que no es creación actual del circuito de «música contemporánea»; típicamente obras ~1900–1970 o compositores cuyo catálogo se trata históricamente como siglo XX (Falla, Boulanger, Jongen, Satie, Hahn).
- **`contemporary`**: compositores vivos y creación posterior ~1970 del ámbito clásico/académico (encargos CNDM/COMA, estrenos absolutos recientes).
- **Romanticismo tardío** (Mahler, Sibelius, Chaikovsky): `romantic`, no `twentieth`, salvo que la fuente sitúe la obra en un marco explícitamente del siglo XX y no haya otra lectura segura.
- Si la frontera es dudosa para una obra concreta: omitir esa era. No adivinar.

`early` cubre medieval / pre-Renacimiento. Cantigas, estampies y repertorio pre-1450 van a `early`. Renacimiento polifónico va a `renaissance`.

---

## 5. `kind`

Contexto **del espacio en el que se celebra el evento**, no ranking de calidad, no profesionalidad, no fama de los intérpretes y no elegibilidad. `kind` no es una propiedad de la source. Un venue del circuito habitual **nunca** convierte por sí solo un evento en música clásica.

Para un evento con `eligibility = include`, `kind` **siempre** tiene exactamente uno de estos dos valores. No existe `unknown` / `undefined` / `uncertain` / `other` para un evento publicable.

| Valor | Label visible | Criterio |
|---|---|---|
| `established` | Circuito habitual | El evento se celebra en un espacio del circuito habitual de programación musical, concertística, escénica o cultural profesional |
| `alternative` | Alternativo | El evento se celebra fuera de ese circuito, en un espacio donde el concierto clásico es un uso menos convencional del lugar |

```text
include + espacio del circuito habitual → established
include + cualquier otro espacio → alternative
```

La señal principal es el **venue canónico** ya resuelto por el pipeline (`venueId` / sede identificada). El organizer, la serie o el texto del programa no cambian la clasificación cuando el lugar está identificado. La calidad o la fama de los intérpretes tampoco: una gran orquesta internacional en una iglesia sigue siendo `alternative`.

`established` cubre, de forma inequívoca, teatros y auditorios de ese circuito (Teatro Real, Teatro de la Zarzuela, Auditorio Nacional — Sala Sinfónica y Sala de Cámara, Teatro Monumental, Teatros del Canal y sus salas, Fundación Juan March) y salas equivalentes con programación cultural/concertística estable.

`alternative` cubre iglesias, parroquias y basílicas; colegios; universidades y aulas; conservatorios y escuelas; centros cívicos o culturales de barrio; bibliotecas; salas multiusos; parques y espacios públicos; y otros lugares no concebidos principalmente como parte de ese circuito.

Un concierto de pop en el Teatro Real puede ser `established` + `exclude`. Un recital de órgano en una basílica, si es música clásica, puede ser `alternative` + `include`. Un open-piano en un puente, si llegara a clasificarse, sería `alternative`; como actividad participativa su elegibilidad es `exclude`.

---

## 6. `access`

Sólo `free` / `paid` / `unknown` cuando la fuente lo soporta.

- precios o «comprar entradas» con tarifa → `paid`;
- «entrada libre», «gratuito», «libre hasta completar aforo» → `free`;
- si no está claro → `unknown`.

No asumir Auditorio = paid, iglesia = free, evento municipal = free.

---

## 7. Cómo se mide

El golden set es la medida. Sobre ese dataset:

- ningún caso `expected.eligibility=exclude` puede avanzar como publicable;
- ningún caso `expected.eligibility=uncertain` puede publicarse automáticamente;
- los casos `include` no deben descartarse por source, venue o `kind`;
- la clasificación no puede depender sólo de source o venue.

Objetivo prioritario: **precision** frente a falsos positivos.

La implementación no debe inventar performers, composers, works, fechas, venues ni access. Deben proceder de observación determinista o de conocimiento autorizado explícito (alias de venue, knowledge de épocas por compositor **ya observado**).

`eras` / `formats`: preferimos vacío a incorrecto; pueden ser múltiples; no bloquean publicación si eligibility es `include` y los datos esenciales son válidos.

La IA interpreta `ObservedFacts`. No inventa hechos. El prompt versionado está en `src/ingestion/classification/ai-prompt.ts`; no es una copia literal de esta política. Valores fuera de taxonomía → inválido → `uncertain`. Ausencia o fallo de IA → `uncertain` → no publicar. CI no llama a un LLM. Tests usan fakes. Los eventos ya publicados no se borran ni se re-clasifican por esta puerta: aplica a nuevos resultados de harvesting.

Forma de cada caso y cómo añadir uno: `tests/fixtures/ingestion/golden/README.md`.
