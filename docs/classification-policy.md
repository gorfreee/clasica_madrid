# Classification Policy v1

Política editorial y operativa para el enrichment de ingestión v3 (fase 2).

No es un campo del schema canónico `Event`. La elegibilidad es metadata interna del pipeline. `formats`, `eras`, `kind` y `access` sí son campos canónicos; esta política dice cómo derivarlos.

La implementación de la fase 2 aún no existe. Este documento y el golden set en `tests/fixtures/ingestion/golden/` son la especificación contra la que se medirá.

## Principio

```text
precision > coverage
observed facts > deterministic interpretation > knowledge > AI > safe unknown
```

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
confidence / evidence
      ↓
Candidate
```

Un `exclude` no debe consumir trabajo innecesario de clasificación posterior. Un `uncertain` degrada de forma segura: no se publica automáticamente.

La fase 2 **implementa** la hidratación de fichas y el contrato de hechos observados (PR 2.1). El harvesting extrae hechos; el classifier de eligibility/formats/eras/kind (PR 2.2) todavía no existe.

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

No clasificar **solo** por palabras del título si existe ficha de detalle.

### 1.2 Exclusiones decididas

Excluir cuando la identidad principal del evento sea una de estas:

**Pop / rock / canción / música popular** arreglada para ensemble clásico. Orquesta, coro o cuerdas no cambian la decisión. Ejemplos: Fito Páez con cuerdas; ABBA, Queen o Beatles con orquesta; Pastora Soler; Jeanette; homenajes pop sinfónicos.

**DJ / electrónica / crossover** cuyo repertorio principal no sea clásico, o cuya identidad sea el formato DJ aunque cite una obra clásica. Ejemplos: DJ Symphonic; Red Bull Symphonic; DJ + Vivaldi como producto crossover.

**Música de cine** como contenido principal: John Williams, Hans Zimmer, Morricone, Film Symphony Orchestra, galas de bandas sonoras. Aunque la música sea orquestal.

**Jazz**, salvo que el evento sea realmente un programa de música clásica y el jazz sea únicamente secundario. Un concierto cuya identidad principal sea jazz → `exclude`. Incluye ciclos institucionales de jazz (p. ej. CNDM «Jazz en el Auditorio»).

**Flamenco**, incluidos homenajes a Paco de Lucía, jóvenes flamencos, zambombas, etc.

**Danza**: espectáculos de danza, incluso con repertorio clásico. Ballet, Alvin Ailey, *El Cascanueces* como representación de danza. La agenda es de eventos musicales, no de artes escénicas en general.

**Cine / proyecciones**: películas, cine familiar, cine mudo con acompañamiento, ciclos cuya actividad principal sea ver una película. Si excepcionalmente la componente principal es una **interpretación musical clásica en directo**, no asumir exclusión automática: evaluar el detalle.

**Talleres / actividades educativas no interpretativas**: talleres, encuentros, charlas, conferencias, actividades paralelas, actividades infantiles tipo taller. Ejemplo: `¿Te suena Manon Lescaut?`. Un concierto real con mediación (p. ej. OCNE «Descubre» con narradora y repertorio clásico) **sí** puede ser `include`: la actividad principal sigue siendo el concierto.

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

### 1.4 Eventos mixtos

Si hay un bloque clásico y otro claramente fuera (folk popular, pop, flamenco) y la identidad anunciada es la del bloque no clásico, `exclude`.

Si el repertorio principal es clásico y el elemento ajeno es claramente secundario, `include`.

Si ambas identidades son coprincipales y no se puede decidir con seguridad, `uncertain`.

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

| Valor | Criterio |
|---|---|
| `established` | Programación profesional o estable del circuito habitual: teatros, auditorios, ópera/zarzuela, ciclos institucionales, orquestas/ensembles profesionales, festivales estables de ese circuito |
| `alternative` | Fuera de ese circuito: amateur, comunitario, parroquial puntual, educativo no institucional de temporada, municipal al aire libre, one-off en espacios no dedicados habitualmente a programación musical |

No deducir de forma permanente:

```text
Auditorio Nacional → established
Madrid Datos → alternative
```

Eso era un fallback provisional de la fase 1.

Un concierto de pop en el Teatro Real puede ser `established` + `exclude`. Un recital de órgano en una basílica, si forma parte de un ciclo concertístico estable, puede ser `established` + `include`. Un open-piano en un puente es `alternative`.

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
deterministic facts/rules → knowledge → AI cuando aporte valor → safe fallback
```

Si la IA no está disponible, hace timeout, devuelve algo inválido o tiene baja confianza: degradación segura. CI no llama a un LLM.

### Tests

El golden set valida el contrato de los fixtures ahora. Los tests parametrizados del classifier se añadirán en la implementación de la fase 2; no se implementa un classifier en esta preparación para hacer pasar expected outputs.

---

## 8. Golden evaluation set

Dataset: `tests/fixtures/ingestion/golden/`.

Aproximadamente 45 eventos reales, mayoritariamente del smoke de fase 1 (`clasica-madrid-phase1-smoke.xlsx`) y algunos del catálogo publicado cuando aportan diversidad (iglesia, museo, festival, Fever, municipal).

Cada caso separa hechos observados de expected. Los `uncertain` declaran qué evidencia falta.

Documentación de composición, conteos y trampas de título: `tests/fixtures/ingestion/golden/README.md`.
