# Discovery manual asistido por un agente

Instrucción operativa para un agente (Codex, Cursor u otro) con acceso a GitHub y búsqueda web. Léela entera y ejecútala de principio a fin. No pidas al usuario que lance comandos si tú puedes completarlos.

Esta repo **no** busca en Internet. Tú investigas; GitHub Actions, con el código de `main` y los secrets del AI pool, clasifica y publica.

Prompt mínimo suficiente para arrancar un ciclo:

```text
Parte del main actual. Lee docs/run-discovery-agent.md, ejecuta un Discovery manual completo siguiendo esas instrucciones y abre la PR resultante.
```

---

## Qué haces tú y qué no

Tú:

* partes del `main` actual;
* generas un `DiscoveryContext` fresco;
* investigas en la web;
* extraes **hechos observados** con la mayor riqueza razonable;
* publicas un `DiscoveryBatch` JSON en una rama de petición;
* lanzas el workflow **Manual discovery** contra `main`;
* sigues la ejecución y reportas el resultado al usuario.

Tú **no**:

* usas ni pides las API keys del AI pool del proyecto;
* decides `eligibility`, `kind`, `formats`, `eras`, `access`, `id`, `slug` ni `confidence`;
* escribes en `data/**` ni abres la PR final de catálogo (eso lo hace Actions);
* ejecutas `ingest:discovery` en local con secrets del pool;
* lanzas el workflow desde una rama que no sea `main`;
* programas un cron ni propones automatizar la periodicidad.

La clasificación y el enrichment finales viven en el pipeline común (`runDiscoveryIngest`), el mismo que harvesting, con `AiClassifier` inyectado desde el entorno de producción.

Pistas de búsqueda (no es un registry): [`discovery-search-hints.md`](discovery-search-hints.md). Contrato de datos: el `output` del `DiscoveryContext` y `src/ingestion/discovery.ts`. Política editorial (no la ejecutas tú): [`classification-policy.md`](classification-policy.md).

---

## 1. Preparación

1. Sincroniza y parte **siempre** del `main` actual:

```bash
git fetch origin main
git checkout -B discovery-request/<yyyy-mm-dd>-<id-corto> origin/main
```

`<id-corto>`: letras, números, `.`, `_` o `-`. La rama de petición **debe** empezar por `discovery-request/`. No uses `automation/discovery-*` (esa es la rama de publicación del workflow).

2. Genera un `DiscoveryContext` fresco con el comando existente. Sin `--from`/`--to`, la ventana es hoy en `Europe/Madrid` → +120 días, la misma que `ingest:sync`.

```bash
npm run ingest:discovery-context -- --output ingestion/work/discovery-context.json
```

El fichero de contexto está gitignorado. No lo commitees.

3. Lee y respeta el JSON:

| Campo | Para qué |
|---|---|
| `window` | Sólo eventos cuya representación cae en este rango. Pásala tal cual al workflow (`from` / `to`). |
| `sources.harvested` | Sources con adapter. **No** hagas una búsqueda sistemática redundante sobre todas ellas. |
| `sources.published` | Sources canónicas ya en el catálogo sin adapter. Útiles para no “descubrir” lo ya cubierto. |
| `venues` | Lugares conocidos y aliases. Reutiliza el nombre exacto cuando coincida. |
| `coveredEvents` | Fingerprints de la ventana. Evita reenviar lo ya cubierto salvo un coverage gap (abajo). |
| `editorialScope` | Orientación geográfica y musical. No sustituye la Classification Policy ejecutable. |
| `evidenceInstructions` | Cómo recoger evidencia. |
| `output` | Contrato del `DiscoveryBatch`: schema, arrays obligatorios, campos prohibidos. |

El alcance geográfico es el municipio de Madrid (`area: madrid`), con `nearby` sólo para municipios muy próximos. No es una agenda de toda la Comunidad.

---

## 2. Investigación

El objetivo principal es encontrar cobertura que **todavía no** proporcionan los adapters.

No realices una búsqueda sistemática redundante sobre todas las `sources.harvested`.

Si durante la investigación aparece un evento relevante de una source que ya tiene adapter pero **no** parece estar en `coveredEvents`, puedes incluirlo como posible coverage gap. El pipeline reconcilia; el report lo marcará como *adapter coverage gap candidate*. No es un error por sí mismo.

Debes:

* hacer búsqueda web amplia, también fuera de cualquier lista predefinida;
* priorizar fuentes primarias u oficiales;
* usar agregadores, buscadores y redes como **leads** cuando ayuden;
* perseguir la fuente oficial cuando exista;
* no inventar hechos;
* incluir siempre una URL http(s) concreta que respalde el evento;
* usar `foundVia` sólo como trazabilidad de descubrimiento (URL de búsqueda, post de Instagram, ficha de Eventbrite, etc.), nunca como source canónica.

Diferencia **lead** y **evidencia**:

* Lead: Google, Eventbrite, Instagram, una agenda agregada.
* Evidencia / `source.url`: la página que declara los hechos (preferiblemente la oficial).

En hosts compartidos (`output.sharedSourceHosts`: Facebook, Instagram, X, Eventbrite, Meetup, …) `source.homepage` debe ser el **perfil** de esa organización, no el origin de la plataforma.

---

## 3. Extracción

El batch contiene **hechos observados**, no decisiones canónicas.

Intenta extraer con exhaustividad razonable cuando la ficha los declare:

* título;
* descripción;
* fecha/hora (`occurrences`: `raw` obligatorio; `date`/`time` si la fuente los deja claros);
* venue (`venueText` y, si el lugar puede ser nuevo, el objeto `venue` con `name`, `municipality` y `area`);
* organizador / ciclo (`organizerText`, `seriesText`);
* intérpretes (`performers`; `[]` si la fuente no los declara);
* compositores (`composers`);
* obras (`works`);
* programa (`programText`);
* texto de acceso/precio (`accessText`);
* categoría oficial si existe (`categoryText`);
* URL oficial que respalda los hechos (`source.url`);
* `foundVia` si procede.

Si una página trae programa completo, intérpretes, compositores u obras, **no** te limites al mínimo para demostrar que el evento existe. El pipeline (determinismo + knowledge + AI pool) clasifica mejor con evidencia rica.

**Prohibido** en el JSON (el schema es `strict` y lo rechazará): `eligibility`, `kind`, `formats`, `eras`, `access`, `id`, `slug`, `confidence`, `candidate`.

`formats` y `eras` los resuelve el pipeline común. El AI pool del proyecto puede intervenir, sólo cuando hace falta, en `eligibility`, `composer-extraction`, `access-classification` y `taxonomy`. Una decisión determinista fuerte no se reabre; un fallo técnico de IA no corrompe datos deterministas válidos.

Un venue nuevo necesita `name` + `municipality` + `area` coherentes. Sin eso no se publica el lugar. No hagas fuzzy matching de salas.

---

## 4. Entrega del DiscoveryBatch

Forma:

```json
{
  "schemaVersion": 1,
  "observations": [ ]
}
```

Un batch vacío es válido (no-op). Prefiérelo a inventar eventos.

Publica **solo** el JSON, en la rama de petición, en:

```text
ingestion/requests/discovery-batch.json
```

Esa ruta está gitignorada en `main`. En la rama de petición:

```bash
mkdir -p ingestion/requests
# escribe el JSON en ingestion/requests/discovery-batch.json
git add -f ingestion/requests/discovery-batch.json
git commit -m "Add discovery batch for manual ingest"
git push -u origin HEAD
BATCH_SHA=$(git rev-parse HEAD)
BATCH_REF=$(git rev-parse --abbrev-ref HEAD)
```

El commit no debe contener código, scripts ni cambios de `data/**`. El workflow **ignora** cualquier otro fichero de esa rama: no ejecuta npm de la petición ni hace checkout de ella. Sólo lee ese JSON si el tip actual de `refs/heads/<batch_ref>` es exactamente `batch_sha`. La rama debe existir **en este repositorio** (no en un fork).

Registra el SHA completo (40 caracteres) del commit que acabas de empujar. El workflow comprueba que ese SHA **sigue siendo el tip** de la rama de petición; si alguien empuja otro commit encima, la run aborta. Un SHA que exista en el repositorio (por ejemplo `main` u otra `discovery-request/…`) no basta.

---

## 5. Ejecución: workflow seguro en main

El workflow se llama **Manual discovery** (`.github/workflows/discovery.yml`). Es `workflow_dispatch` **sin** `schedule`.

Lánzalo **siempre** contra `main`. El código que corre con secrets es el de `main`; el batch es dato no confiable.

```bash
gh workflow run "Manual discovery" --ref main \
  -f batch_ref="$BATCH_REF" \
  -f batch_sha="$BATCH_SHA" \
  -f batch_path="ingestion/requests/discovery-batch.json" \
  -f from="<window.from del DiscoveryContext>" \
  -f to="<window.to del DiscoveryContext>"
```

`from`/`to` son la ventana del contexto. Si los omites, Actions usa hoy → +120 días en el momento de la run (puede no coincidir con el contexto que usaste).

El job hace checkout de `main` **sin** persistir credenciales del `GITHUB_TOKEN` de solo lectura. Lee el batch con ese token de la run (`github.token`, `contents: read`): `git fetch` de `refs/heads/<batch_ref>` hacia un ref local temporal, comprueba que el tip es `batch_sha` y entonces `git cat-file` del blob. La publicación de `automation/discovery-*` se autentica aparte con `INGESTION_BOT_TOKEN`, igual que Production ingestion. No pongas tokens en la línea de comando.

Sigue la ejecución (no pidas al usuario que lo haga):

```bash
gh run list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  --workflow "Manual discovery" --limit 5
gh run watch <run-id>
gh run view <run-id>
```

Job Summary y artifact `discovery-run-<run-id>-<attempt>` (retención 90 días): batch exacto, `batch-meta.json`, `report.json`, `run.json`, `events.jsonl`, `run.log`. No contienen secrets.

La PR de catálogo, si hay cambios válidos, la abre el workflow:

* rama `automation/discovery-<run-id>-<attempt>` (no confundir con `discovery-request/…`);
* título `Discovery catalog update`;
* sólo `data/**`;
* draft si `health == review`;
* **sin auto-merge**. Revisión humana siempre.

Localiza la PR:

```bash
gh pr list --base main --search "Discovery catalog update" --state open
gh pr view <n>
```

También está enlazada en el Job Summary de la run.

---

## 6. Informe al usuario

Cuando termines, informa con claridad:

* URL de la run de GitHub Actions y su conclusión;
* `health` y `healthReasons`;
* eventos nuevos / actualizados / sin cambios;
* `exclude` / `uncertain` / descartes estructurales;
* nuevas sources y nuevos venues (si el summary los lista);
* duplicados del lote y corroboraciones cross-source;
* *adapter coverage gap candidates* (observaciones de sources ya adaptadas);
* problemas o elementos que necesiten revisión humana;
* URL de la PR de catálogo, o que fue no-op / `fatal` (sin PR).

No pegues API keys, tokens ni el contenido de `.local/ai.env`.

---

## 7. Modelo de seguridad (no lo eludas)

```text
rama de petición (DiscoveryBatch JSON)
        │
        │ fetch de refs/heads/<batch_ref> → tip exacto = batch_sha
        │ después, blob <batch_sha>:<batch_path>
        ▼
workflow lanzado desde main
        │
        │ checkout de main (sin persistir credenciales)
        │ lectura del batch con el token de la run (solo lectura)
        │ código de main + secrets del AI pool
        │ publicación con INGESTION_BOT_TOKEN
        ▼
npm run ingest:discovery → pipeline común → PR de data/**
```

Inaceptable: checkout de la rama del agente → `npm` / scripts de esa rama → secrets disponibles.

Si el workflow rechaza el `ref` porque no es `main`, relánzalo con `--ref main`. No copies secrets a tu entorno para “saltarte” Actions.
