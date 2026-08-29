# Classification Policy v1

Política editorial y operativa para el enrichment de ingestión v3 (fase 2).

No es un campo del schema canónico `Event`. La elegibilidad es metadata interna del pipeline. `formats`, `eras`, `kind` y `access` sí son campos canónicos; esta política dice cómo derivarlos.

La implementación de la fase 2 vive en `src/ingestion/classification/` y se conecta al pipeline en `runIngest`. Flujo: hechos observados → classifier determinista → fallback de IA si `uncertain` → puerta de publicación (`include` → Candidate; `exclude`/`uncertain` → no publicar). Este documento y el golden set en `tests/fixtures/ingestion/golden/` son la especificación contra la que se mide.

## Principio

```text
precision > coverage
observed facts → deterministic rules → musical knowledge → AI → safe uncertain
```

En la fase 2.2 no hay IA. El comportamiento correcto del núcleo determinista es:

```text
observed facts → deterministic rules → musical knowledge → safe uncertain
```

La fase 2.3 añade el fallback de IA **sólo** sobre `uncertain`. Un `include` o `exclude` determinista no se reabre. Si la IA no está disponible o falla, el resultado sigue siendo `uncertain`.

Preferimos perder temporalmente un evento antes que publicar un falso positivo.

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
evidence (interna)
      ↓
Candidate
```

Un `exclude` no debe consumir trabajo innecesario de clasificación posterior. Un `uncertain` degrada de forma segura: no se publica automáticamente.

La fase 2.1 implementa la hidratación de fichas y el contrato de hechos observados. La fase 2.2 implementa el classifier determinista (`classify(observed)`). La fase 2.3 implementa `classifyObserved` (IA sólo si `uncertain`). La fase 2.4 conecta ese resultado a `runIngest` como puerta de publicación.

## Lo que no es esta política

```text
eligibility ≠ format
eligibility ≠ kind
eligibility ≠ source
eligibility ≠ venue
```

Ejemplos:

- `format=symphonic` no implica música clásica. ABBA con orquesta puede ser `symphonic` y `exclude`.
- `kind=established` no implica música clásica. Un concierto de pop en el Teatro Real puede ser `established` y `exclude`.
- Venir del Teatro Real, del Auditorio Nacional o del CNDM no implica inclusión.
- Una agenda municipal no implica exclusión.

La decisión se basa principalmente en **qué repertorio se interpreta y cuál es la naturaleza musical real del evento**.

La presencia de orquesta, instrumentos clásicos, sala clásica, músicos de formación clásica o arreglos sinfónicos **no convierte** un evento en música clásica.

---

## 1. Eligibility (tri-state interno)

Valores:

| Valor | Semántica | ¿Publicable automáticamente? |
|---|---|---|
| `include` | Hay evidencia suficiente de que el evento pertenece al ámbito de Clásica Madrid | sí, si el resto de datos esenciales es válido |
| `exclude` | Hay evidencia suficiente de que está fuera | no |
| `uncertain` | La evidencia no permite decidir con seguridad | no |

`uncertain` no es un sí débil. Es un no a la publicación automática.

### 1.1 Ámbito musical

Clásica Madrid incluye eventos cuyo contenido musical principal sea **música clásica occidental**, en sentido amplio:

- música antigua;
- Renacimiento;
- Barroco;
- Clasicismo;
- Romanticismo;
- repertorio de los siglos XX y XXI del ámbito de la música clásica;
- creación contemporánea de tradición clásica / académica.

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

No decidir por el título solo cuando sea genérico, poético, un código interno o un nombre de intérprete sin programa:

- Concierto de Navidad / Gala de Navidad;
- Concierto extraordinario / aniversario;
- `OCNE Sinfónico 01`;
- títulos puramente poéticos;
- nombres de intérpretes sin programa.

Tras consultar las fuentes oficiales, si el repertorio queda claro, decidir `include` o `exclude`. Si sigue sin haber evidencia suficiente → `uncertain`.

Un título que *parece* clásico puede ser un gala popular. Un título que *parece* genérico puede ser Mahler. La ficha manda.

La ausencia de programa obra-por-obra **no** obliga siempre a `uncertain`. Un concierto puede tener evidencia suficiente para `include` cuando la fuente oficial demuestra de forma clara que:

- se trata de un concierto real (no un taller, jam, open piano ni otra actividad no interpretativa);
- pertenece a un festival o ciclo explícitamente de música clásica; o
- está interpretado por una formación clásica dentro de una serie cuya identidad clásica está suficientemente establecida.

Eso es evidencia válida sobre **ese evento**. No es una regla automática por source ni por venue (`eligibility ≠ source`, `eligibility ≠ venue`). Un mismo ciclo puede contener actividades excluidas: cada evento se evalúa individualmente.

### 1.4 Eventos mixtos

Un evento mixto puede ser `include` si contiene un **bloque clásico sustancial, autónomo e identificable** y el evento global se presenta genuinamente como concierto musical clásico o sinfónico.

Debe seguir siendo `exclude` cuando lo clásico sea principalmente acompañamiento, arreglo, ornamentación o formato instrumental de una identidad predominantemente pop/rock, canción popular, jazz, flamenco, música de cine, crossover, DJ/electrónica u otra categoría expresamente excluida.

La presencia de orquesta, de un piano o de un compositor clásico aislado **no** convierte en `include` un homenaje pop, un tributo de cine o un espectáculo crossover.

Ejemplos:

- `include`: concierto sinfónico real con una primera parte de repertorio clásico autónomo (obras de concierto, solista y orquesta) y una segunda parte de repertorio popular o regional.
- `exclude`: ABBA, Queen o Beatles con orquesta; tributo a Hans Zimmer o Morricone; pop anunciado como «de clásico a lo pop»; espectáculo de humor/crossover que parodia un recital.
- `uncertain`: las dos identidades son coprincipales y no hay un bloque clásico autónomo ni una identidad no clásica que mande con claridad.

---

## 2. Hechos observados vs inferencias

```text
source parsing
      ↓
observed facts
      ↓
enrichment / classification
```

**Hechos observados** (el adapter o la hidratación de detalle los extrae; no se inventan):

- título, descripción, categoría oficial de la fuente;
- fechas, lugar, URL;
- performers, composers, works, programa, cuando la fuente los declara;
- texto de acceso, cuando existe.

**Inferencias** (enrichment):

- `eligibility`;
- `formats`, `eras`, `kind`;
- `access` sólo si el texto de la fuente lo soporta;
- roles canónicos de intérprete, cuando el texto lo permite con seguridad.

La knowledge base puede asociar `Bach → baroque`. No puede afirmar que Beethoven participa en un programa donde la fuente no lo menciona.

CI y tests no deben depender de llamadas live a un LLM. Si la IA no está disponible, hace timeout, devuelve algo inválido o tiene baja confianza, el pipeline degrada: reglas y knowledge si bastan; si no, `uncertain` / campos vacíos.

---

## 3. `formats[]`

Taxonomía vigente: `symphonic`, `chamber`, `recital`, `choral`, `organ`, `early-music`, `opera`, `zarzuela`, `lied`, `other`.

Pueden ser múltiples. Vacío es mejor que incorrecto. Un `format` incorrecto no debe bloquear un `include` fiable, pero el golden set espera valores cuando la evidencia es clara.

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

Taxonomía vigente: `early`, `renaissance`, `baroque`, `classical`, `romantic`, `twentieth`, `contemporary`.

Pueden ser múltiples. Vacío es mejor que incorrecto. No bloquean publicación si `eligibility=include`.

Orden de evidencia:

1. obras identificadas;
2. si no hay obras, compositores declarados por la fuente;
3. si no hay ninguna de las dos, vacío. No deducir época por el nombre del ensemble, del ciclo o del venue.

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

Contexto del evento, **no** ranking de calidad y **no** elegibilidad.

Para un evento con `eligibility = include`, `kind` **siempre** tiene valor. No existe `unknown` / `undefined` / `uncertain` para un evento publicable.

| Valor | Criterio |
|---|---|
| `established` | Evidencia clara de circuito profesional/estable: venue reconocido, organizer institucional, serie/ciclo estable, programación profesional estable, festival estable de ese circuito |
| `alternative` | Cualquier otro caso. No significa que sepamos que el evento es amateur: significa que no hay evidencia suficiente para etiquetarlo como circuito established |

```text
include + clearly established → established
include + otherwise → alternative
```

No deducir de forma permanente:

```text
Auditorio Nacional → established
Madrid Datos → alternative
```

Eso era un fallback provisional de la fase 1, ya retirado: `provisionalKind` ya no existe. `kind` no es una propiedad de la source.

Un concierto de pop en el Teatro Real puede ser `established` + `exclude`. Un recital de órgano en una basílica, si forma parte de un ciclo concertístico estable, puede ser `established` + `include`. Un open-piano en un puente, si llegara a clasificarse, sería `alternative`; como actividad participativa su elegibilidad es `exclude`.

---

## 6. `access`

Sólo `free` / `paid` / `unknown` cuando la fuente lo soporta.

- precios o «comprar entradas» con tarifa → `paid`;
- «entrada libre», «gratuito», «libre hasta completar aforo» → `free`;
- si no está claro → `unknown`.

No asumir:

```text
Auditorio = paid
iglesia = free
evento municipal = free
```

---

## 7. Acceptance criteria de Phase 2

Estos criterios son objetivos. El golden set es la medida.

### Eligibility

Sobre el golden set:

- ningún caso `expected.eligibility=exclude` puede avanzar como publicable;
- ningún caso `expected.eligibility=uncertain` puede publicarse automáticamente;
- los casos `include` deben mantenerse como publicables (no descartarlos por source, venue o `kind`);
- la clasificación no puede depender sólo de source o venue: CNDM y Teatro Real contienen tanto `include` como `exclude`.

Objetivo prioritario: **precision** frente a falsos positivos.

### Hechos

La implementación no debe inventar performers, composers, works, fechas, venues ni access. Deben proceder de observación determinista o de conocimiento autorizado explícito (p. ej. alias de venue, knowledge de épocas por compositor **ya observado**).

### Eras / formats

- preferimos vacío a incorrecto;
- pueden ser múltiples;
- no bloquean publicación si eligibility es `include` y los datos esenciales son válidos.

### IA

Arquitectura:

```text
deterministic facts/rules → knowledge → AI cuando eligibility=uncertain → safe fallback
```

La IA interpreta `ObservedFacts`. No inventa performers, composers, works, fechas, horas, venue, organizadores, precios, acceso ni URLs. Puede usar conocimiento musical general. `uncertain` es una salida válida.

El prompt versionado del fallback está en `src/ingestion/classification/ai-prompt.ts` (`AI_CLASSIFIER_PROMPT_VERSION`). Resume esta política de forma compacta; no es una copia literal. Subir la versión permite distinguir resultados de prompts distintos.

Contrato de salida: objeto JSON validado con Zod (`eligibility` obligatorio; `formats` / `eras` / `kind` / `evidence` opcionales). Valores fuera de taxonomía → inválido → `uncertain`.

Degradación: provider ausente, API key ausente, timeout, error HTTP, excepción, respuesta vacía, JSON inválido o schema inválido conservan `eligibility = uncertain` y no tumbaron el resto del lote. El `ruleId` interno (`ai-unavailable`, `ai-timeout`, `ai-error`, `ai-malformed-output`, `ai-invalid-output`) permite diagnosticar el fallo. OpenAI y Gemini comparten el mismo prompt y la misma puerta `parseAiClassification()`.

CI no llama a un LLM. Tests usan fakes. El resultado final gobierna la publicación de `runIngest`: sólo `include` puede convertirse en Candidate. `exclude` y `uncertain` no se publican. Ausencia o fallo de IA → `uncertain` → no publicar. `eras=[]` / `formats=[]` no bloquean un `include`. Los eventos ya publicados no se borran ni se re-clasifican en esta fase.

### Tests

El golden set valida el contrato de los fixtures. La fase 2.2 ejecuta el classifier determinista sobre `golden.observed`. La fase 2.3 evalúa el mismo set con un fake de IA cuando el determinista es `uncertain`. La fase 2.4 demuestra la puerta de publicación en el pipeline completo (`tests/ingestion-publication-gate.test.ts`). CI no llama a un LLM. Sin IA, la cobertura de `include` no es un objetivo de recall.

---

## 8. Golden evaluation set

Dataset: `tests/fixtures/ingestion/golden/`.

Aproximadamente 48 eventos reales, mayoritariamente del smoke de fase 1 (`clasica-madrid-phase1-smoke.xlsx`) y algunos del catálogo publicado cuando aportan diversidad (iglesia, museo, festival, Fever, municipal).

Cada caso separa hechos observados de expected. Los `uncertain` declaran qué evidencia falta.

Documentación de composición, conteos y trampas de título: `tests/fixtures/ingestion/golden/README.md`.
