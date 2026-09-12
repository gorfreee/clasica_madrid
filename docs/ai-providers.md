# Pool de IA gratuito

Producción usa un pool ordenado de routes `provider:model`. Gemini conserva la prioridad inicial; Groq, Mistral, Z.AI y Cloudflare Workers AI aportan capacidad adicional. La primera respuesta que supera el schema del purpose termina la llamada. No hay voting, consensus ni llamadas duplicadas tras un resultado válido.

## Garantía operativa de coste cero

El workflow declara `AI_ZERO_COST_ONLY=true`. Con esa política:

- OpenAI queda fuera del pool de producción y sólo se conserva como integración manual legacy;
- Groq exige `GROQ_FREE_TIER_CONFIRMED=true` además de su key;
- Mistral exige `MISTRAL_FREE_MODE_CONFIRMED=true`; la cuenta debe seguir en Free mode y PAYG debe estar desactivado;
- Z.AI sólo admite `glm-4.7-flash` y `glm-4.5-flash`;
- Cloudflare sólo admite la allowlist versionada, exige `CLOUDFLARE_WORKERS_FREE_CONFIRMED=true` y llama directamente a Workers AI, nunca a AI Gateway;
- una route no demostrablemente autorizada se omite o hace fallar la configuración antes del primer HTTP request.

La confirmación de Cloudflare significa que la cuenta permanece en **Workers Free**. Workers Free corta las llamadas al agotar la asignación diaria; Workers Paid cobra automáticamente el exceso y por tanto no cumple esta política. El error Workers AI `3036` se registra como asignación diaria agotada y bloquea esas routes hasta el reset UTC.

Los modelos y condiciones se verificaron en documentación oficial el 12-09-2026. Los proveedores pueden cambiar su oferta: antes de actualizar una allowlist o confirmar de nuevo un plan, hay que volver a comprobarla. La seguridad prima sobre la disponibilidad.

## Orden y configuración

Los defaults son:

1. routes Gemini ya configuradas;
2. `groq:openai/gpt-oss-120b`;
3. `groq:qwen/qwen3.8-27b`;
4. `groq:openai/gpt-oss-20b`;
5. `mistral:ministral-14b-2512` y `mistral:ministral-8b-2512` (14B primero: más calidad; 8B como fallback más rápido en RPS);
6. `zai:glm-4.7-flash` y `zai:glm-4.5-flash`;
7. `cloudflare:@cf/zai-org/glm-4.7-flash` y `cloudflare:@cf/google/gemma-4-26b-a4b-it`.

Cada lista puede reordenarse con `*_MODELS`. Unset significa «usar el default versionado en Git». En zero-cost mode, Z.AI, Cloudflare y Gemini rechazan IDs fuera de su allowlist.

Los defaults de Mistral son IDs versionados, no aliases `latest`. Los límites de presión asociados son los de **esta** organización de Clásica Madrid, comprobados en el dashboard en septiembre de 2026; no son cuotas universales de Mistral:

| Modelo | TPM real | RPS real | Default en código |
|---|---:|---:|---|
| `ministral-14b-2512` | 937.500 | 0,50 | `tpm` 937500, `maxConcurrent` 1, `minIntervalMs` 2100 |
| `ministral-8b-2512` | 625.000 | 3,13 | `tpm` 625000, `maxConcurrent` 1, `minIntervalMs` 350 |

`mistral-small-latest` no es el default de producción: en esta cuenta el modelo actual detrás del alias sólo tiene 20.000 TPM / 1 RPS. `ministral-3b-2512` puede usarse como override futuro, pero no está activado por defecto.

Z.AI no tiene un RPM/RPD universal inventado. El default de producción es `providerMaxConcurrent=1` porque el código de negocio `1302` es high concurrency, no cuota diaria ni clave inválida. Tras un `1302` el scheduler reduce de forma genérica la presión restante de ese provider a 1 request simultánea durante la run; no abre circuito ni marca `quotaExhausted`.

Esos `*_MODELS` / `*_MODEL_RPM` / `*_MODEL_TPM` / `*_MODEL_RPD` / controles de presión son configuración no sensible. En producción el workflow puede leerlos de `vars.*` (nunca de secrets) como **override opcional**. Si la variable de repositorio está vacía o ausente, se aplican los defaults de código. En local viven en `.local/ai.env`.

El scheduler entiende límites genéricos de presión por route/provider. No hay `if (provider === …)` en el scheduler: el profile/transport interpreta códigos y headers; la reacción (cooldown, cap de concurrencia, reporting) es genérica.

| Control en la route | Env | Significado |
|---|---|---|
| `maxConcurrent` | `*_MODEL_MAX_CONCURRENT` (pares `modelo:entero`) | HTTP simultáneos de esa route |
| `minIntervalMs` | `*_MODEL_MIN_INTERVAL_MS` (pares `modelo:entero`) | Separación mínima entre comienzos de requests de esa route |
| `providerMaxConcurrent` | `*_MAX_CONCURRENT` | Límite agregado de HTTP in-flight del provider |
| `providerMinIntervalMs` | `*_MIN_INTERVAL_MS` | Separación agregada entre comienzos de requests del provider |

El workflow inyecta GROQ, MISTRAL, ZAI y CLOUDFLARE desde `vars.*` si existen. `.local/ai.env` carga las mismas claves. Un valor ausente usa el default de código. `0` conserva la semántica ya soportada por el scheduler: `rpm`/`tpm`/`rpd`/`maxConcurrent`/`providerMaxConcurrent` a 0 deshabilitan esas routes; `minIntervalMs`/`providerMinIntervalMs` a 0 no deshabilitan, sólo no añaden holgura. No uses `0` como sinónimo de unset.

Durante una ejecución, una route que acumula varios fallos consecutivos relevantes (empty/incomplete/timeout/transport/output inválido) sin un resultado válido entre medias abre un circuit breaker in-memory. `formats=[]` **no** cuenta como `incomplete` cuando los hechos observados muestran alternativas exclusivas o programación todavía por determinar (`observedFormatChoiceIsUnresolved`): es una resolución válida, cacheable y final. Rate limits, RPM/RPD y cuota diaria siguen sus mecanismos propios. El circuito no se persiste entre runs y nunca introduce un provider de pago.

## Perfiles HTTP por modelo

Las tareas del pool (eligibility, compositores, acceso, taxonomy) piden JSON corto. Cada route declara sus capacidades en `openaiCompatibleModelProfile` / `geminiModelProfile`; el transport no adivina flags. Timeout productivo de cada HTTP: 15 s (`AI_CLASSIFY_TIMEOUT_MS`). El live smoke usa 30 s y no cambia este valor.

| Route | Structured output | Reasoning / thinking | Tokens | Por qué |
|---|---|---|---|---|
| Gemini `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-2.5-flash` | Interactions API + schema del purpose (`response_format.schema`) | `thinking_level: low` (el mínimo documentado; `minimal` no está permitido) | `max_output_tokens` por purpose | Structured output nativo. No se sube el tope para tapar `MAX_TOKENS`. |
| Gemini `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` | igual | `thinking_level: minimal` | igual | `minimal` está en el set documentado. `gemini-3.1-flash-lite` no aparece en la tabla oficial 2026-09-12 (sí `…-image`); se mantiene `minimal` porque este proyecto ya lo verificó. |
| Gemini `gemma-4-31b-it`, `gemma-4-26b-a4b-it` | igual | no se envía `thinking_level` | igual | Gemma no documenta esos niveles en Interactions API. |
| `groq:openai/gpt-oss-20b`, `groq:openai/gpt-oss-120b` | `json_schema` + `strict: true` (constrained decoding) | `include_reasoning: false` y `reasoning_effort: low` | `max_tokens` | Strict está documentado para estos dos IDs. `include_reasoning: false` sólo oculta el campo; `low` reduce thought tokens. `reasoning_format` no está soportado. Los schemas por purpose ya tienen `additionalProperties: false` y todos los campos required. |
| `groq:qwen/qwen3.8-27b` | `json_schema` + `strict: false` | `reasoning_effort: none` | `max_tokens` | JSON Schema sí está documentado. Strict aparece en una tabla y se contradice en otra de la misma página (y en el partner LangChain: sólo GPT-OSS). Conservador: best-effort. `none` está documentado para desactivar reasoning en Qwen 3.8. Preview: se mantiene en el pool. |
| otros `groq:*` | `json_object` | no se envía | `max_tokens` | Sin Structured Outputs documentado. |
| `mistral:ministral-14b-2512`, `mistral:ministral-8b-2512` | `json_schema` + `strict: true` | no se envía | `max_tokens` | Custom structured outputs / `json_schema` está en la API de Chat Completions; el ejemplo oficial usa Ministral 8B. `service_tier=standard_only` (Free / Standard). Validación local sigue. Un override tipo `mistral-small-latest` permanece en `json_object`. |
| `zai:glm-4.7-flash`, `zai:glm-4.5-flash` | `json_object` | `thinking: { type: "disabled" }` | `max_tokens` | Z.AI documenta JSON mode, no `json_schema`. Thinking on por defecto en GLM-4.7 y consume el presupuesto de salida. 4.5-flash se mantiene aunque sea más lento. |
| `cloudflare:@cf/zai-org/glm-4.7-flash`, `cloudflare:@cf/google/gemma-4-26b-a4b-it` | no se envía `response_format` | `reasoning_effort: null` y `chat_template_kwargs.enable_thinking: false` | `max_completion_tokens` | La allowlist oficial de JSON Mode no incluye estos IDs. `max_tokens` está deprecated en las páginas de modelo a favor de `max_completion_tokens`. Prompt + parseo + schema local. |

Un 1305 de Z.AI (oficialmente HTTP 429, «temporarily overloaded»; también se ha visto 503) se clasifica como `capacity` / `PROVIDER_BUSY`. El pool salta esa route en la misma llamada si hay otra lista; no convierte el busy en una espera larga de Retry-After. El live smoke no reintenta.

`--ai-max-requests` limita los HTTP requests del pool completo, incluidos fallos, retries y fallbacks. `--ai-route provider:model` fija una sola route para diagnóstico.

El `report.json`, el resumen de consola y el Job Summary separan provider, modelo y `routeId`. Distinguen llamadas lógicas, requests HTTP, retries de la misma route, HTTP de fallback, llamadas con fallback, caché, deferred, rate limits, **concurrency-pressure**, cuotas agotadas y circuitos abiertos. Un 429 de Mistral sin headers extra aparece como rate-limit indeterminado, no como cuota agotada. Si llegan `x-ratelimit-remaining-req-minute` / `tokens-minute` / `tokens-month` (o `Retry-After`), el report indica request-frequency, TPM, monthly o reset. Un `1302` de Z.AI aparece como `concurrency-pressure`, no como rate-limit genérico ni como cuota diaria. Hay una tabla compacta por route (HTTP, válidas, rate limits, pressure, circuito). El detalle completo permanece en el artifact.

## Smoke tests manuales

Son llamadas **live** a las APIs de los proveedores: consumen quota real. No se ejecutan automáticamente en CI (ni en push ni en pull request), no escriben `data/**` y no crean PRs. Conviene lanzarlos tras cambiar providers, modelos, transports o prompts, o cuando una ingestión muestre comportamientos sospechosos.

Descubren las routes con la misma configuración que el pool de producción (`inspectFreePoolFromEnv`) y reutilizan directamente cada transport, payload, prompt, schema y parser real. El runner llama una sola vez a `route.transport.request()` por celda: no usa `AiPoolClassifier`, retries, fallback, cache, scheduler, circuit breaker ni estado persistente. Un proveedor esperado sin key o sin confirmación gratuita no desaparece: cuenta como FAIL.

El timeout productivo del pool sigue en 15 s. El **live smoke** usa un hard timeout de 30 s y marca como `SLOW` (sigue siendo PASS funcional) cualquier respuesta correcta ≥ 15 s. Un corte a 30 s es `TIMEOUT`. `--timeout-ms` / `--slow-threshold-ms` (o `AI_SMOKE_TIMEOUT_MS` / `AI_SMOKE_SLOW_THRESHOLD_MS`) permiten override explícito.

Por defecto prueba un solo purpose (`eligibility`, como máximo un HTTP por route). `--purpose taxonomy` cambia el fixture; `--all-purposes` recorre eligibility, composer extraction, access y taxonomy (como máximo un HTTP por `route × purpose`). Cada fixture declara una expectativa semántica mínima y no ambigua; no basta con devolver JSON compatible.

Los providers avanzan en paralelo. Dentro de cada provider hay como máximo dos workers —o menos si `providerMaxConcurrent` es más restrictivo—, cada route mantiene un único request en vuelo y los inicios respetan sus `rpm` / `minIntervalMs` y el `providerMinIntervalMs`. No hay retries ocultos. Un fallo funcional, output inválido, timeout, `SLOW` o 429 transitorio no impide probar los demás purposes. Sólo auth, modelo inequívocamente inexistente/no disponible y cuota diaria explícitamente agotada bloquean los purposes restantes de esa route.

```bash
# una sola route (eligibility)
npm run ai:smoke -- --route groq:openai/gpt-oss-120b
npm run ai:smoke -- --route mistral:ministral-14b-2512
npm run ai:smoke -- --route mistral:ministral-8b-2512
npm run ai:smoke -- --route zai:glm-4.7-flash
npm run ai:smoke -- --route cloudflare:@cf/zai-org/glm-4.7-flash

# una sola route, las cuatro tasks
npm run ai:smoke -- --route groq:openai/gpt-oss-120b --all-purposes

# todas las routes, una petición de eligibility por modelo
npm run ai:smoke:all

# todas las tasks (`AI_CALL_PURPOSES`) en todas las routes
npm run ai:smoke:all -- --all-purposes

# artefactos locales (Job Summary / GitHub artifact en el workflow)
npm run ai:smoke:all -- --all-purposes --report-dir /tmp/ai-smoke-report
```

El comando carga `.local/ai.env`, fuerza `AI_ZERO_COST_ONLY=true` e imprime una línea JSON por celda más el informe Markdown. En GitHub Actions el mismo Markdown se publica en `$GITHUB_STEP_SUMMARY` y se suben `ai-smoke-report.md` / `ai-smoke-report.json` aunque el smoke falle. Los estados son:

- `PASS`: estructura y semántica esperadas en menos de 15 s;
- `SLOW`: igual que PASS, pero la respuesta tardó ≥ 15 s (no es un fallo funcional);
- `SEMANTIC_FAIL`: schema válido, resultado equivocado;
- `SCHEMA_FAIL`: objeto parseable que incumple el schema, sin señal de recorte de output;
- `INVALID_OUTPUT`: JSON realmente malformado/vacío, sin mejor explicación;
- `OUTPUT_LIMIT`: la generación se cortó al alcanzar el presupuesto de salida (`incomplete`, `finish_reason=length`/`max_tokens`, o tokens de salida ≈ `maxOutputTokens`);
- `RATE_LIMIT`: 429/límite transitorio sin dimensión clara;
- `RPM` / `TPM` / `OTPM` / `CONCURRENCY`: requests/minuto, tokens/minuto, output-tokens/minuto o presión de concurrencia;
- `PROVIDER_BUSY`: capacidad/overload del proveedor (p. ej. Z.AI `1305` con cuerpo de overload);
- `DAILY_QUOTA`: cuota diaria explícita;
- `TIMEOUT`, `AUTH`, `MODEL_UNAVAILABLE`, `REQUEST_ERROR` o `TRANSPORT_ERROR`: causa técnica concreta;
- `CONFIG_ERROR`: route/provider no configurado;
- `BLOCKED`: no hizo request porque un fallo global previo de esa route lo hacía inútil.

Z.AI, tabla oficial comprobada el 2026-09-12 ([códigos de error](https://docs.z.ai/api-reference/api-code)): `1302` es concurrency (el mensaje oficial dice "Rate limit reached for requests"; en producción también aparece "High concurrency usage…"); `1305` es overload/capacity (HTTP 429 oficial; el código basta, no hace falta que el body repita "overload"). `1303` (frequency) y `1304` (daily) **no** están en esa tabla; si aparecen en un body los clasificamos así, sin inventar semántica cuando el código/mensaje no permiten distinguirla.

```text
# AI live smoke — FAIL

- Resultado global: **FAIL**
- Routes: **12 PASS** / **3 PARTIAL** / **1 FAIL**
- HTTP requests: **54**
- Duración: **3.8 min**

| Provider | Model | Eligibility | Composer | Access | Taxonomy | Latency | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini | gemini-3.8-flash | TIMEOUT | PASS | SLOW | DAILY_QUOTA | 41.0 s | PARTIAL |
| groq | openai/gpt-oss-120b | PASS | PASS | PASS | PASS | 3.5 s | PASS |
```

En GitHub hay workflows manuales (`workflow_dispatch`, `contents: read`, mismos secrets/`vars` que la ingestión). No publican datos:

- **AI route smoke** — una route exacta (`provider:model`) y un purpose (o `all`).
- **AI live smoke test** — `npm run ai:smoke:all`, con el input `all_purposes`.
- **AI live qualification** — `npm run ai:qualify`, benchmark de calidad (sección siguiente).

## Qualification benchmark

Herramienta **distinta** del smoke. El smoke responde «¿esta route acepta nuestro request y devuelve JSON compatible?». El qualification responde «¿qué models son fiables en eligibility, composers, formats, eras y access con casos representativos?».

No se ejecuta en PR, push ni schedule. No cambia el orden de producción, no elimina routes y no usa un LLM como juez. Cada celda llama exactamente a la route seleccionada: mismo `route.transport.request()`, prompt, schema y parser que producción; sin pool, retry, fallback ni circuit breaker. Un 429 o provider-busy se registra como tal.

El dataset vive en `tests/fixtures/ingestion/ai-qualification/dataset.json`. Reutiliza golden cases y añade extras sólo donde el golden no cubre el hueco (intérprete vs compositor, arreglista, texto desordenado, keyword de biografía, Casulana, reserva/invitación). Suite `core` (~17 casos, pensada para el RPD 18 de Gemini flash) o `full` (32 casos).

```bash
# por defecto: suite core (~17 casos), todas las routes del pool
npm run ai:qualify

# suite completa (32 casos; más cuota; Gemini flash puede llegar a daily-quota)
npm run ai:qualify -- --suite full

# un purpose, un provider
npm run ai:qualify -- --suite full --purpose eligibility --providers groq

# una route y un tope de casos
npm run ai:qualify -- --route mistral:ministral-14b-2512 --max-cases 8 --report-dir /tmp/ai-qualify-report
```

Coste aproximado: `casos × routes` HTTP. `core` × pool por defecto ≈ 17 × N; `full` ≈ 32 × N. Gemini flash declara RPD 18: `full` puede terminar en `daily-quota` en esos models; no se oculta con fallback. Timeout del workflow: 60 min. Hard timeout por request: 30 s, igual que el smoke, sin retries.

El Job Summary (y `ai-qualify-report.md` / `ai-qualify-report.json`) separa transporte, contrato, semántica y evidence grounded. El ranking por purpose es informativo: semántica → evidence → schema → transporte → p50 → tokens de salida. Una muestra insuficiente se marca. El JSON guarda timestamp, commit SHA, dataset id, contract/prompt versions y la config de la run para comparar ejecuciones.

Workflow manual: **AI live qualification** (`.github/workflows/ai-live-qualification.yml`).

## Checklist después del merge

1. Añadir el secret `GROQ_API_KEY`.
2. Confirmar en Groq que la organización sigue en Free tier.
3. Añadir la repository/environment variable `GROQ_FREE_TIER_CONFIRMED=true`.
4. Añadir el secret `MISTRAL_API_KEY`.
5. Confirmar Mistral Free mode y PAYG desactivado.
6. Añadir `MISTRAL_FREE_MODE_CONFIRMED=true` como repository/environment variable.
7. Confirmar que siguen existiendo los secrets `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
8. No crear nuevas credenciales Cloudflare.
9. Añadir únicamente `CLOUDFLARE_WORKERS_FREE_CONFIRMED=true` como repository/environment variable, tras confirmar Workers Free.
10. Añadir el secret `ZAI_API_KEY`.
11. Verificar que `ZAI_MODELS` sólo contiene modelos explícitamente gratuitos; por defecto no hace falta crear esta variable.
12. Ejecutar `npm run ai:smoke:all` (y `--all-purposes` si cambian las tasks), o una route concreta con `npm run ai:smoke -- --route …` / el workflow **AI route smoke**. El workflow **AI live smoke test** cubre el barrido completo.
13. Lanzar un `workflow_dispatch` en `dry-run` antes del primer publish.

No hace falta crear repository variables de `*_MODELS`, `*_MODEL_TPM` ni `*_MAX_CONCURRENT` para que producción funcione: esos defaults viven en el código. Las variables siguen siendo overrides de emergencia.

Las keys ausentes dejan fuera su provider sin romper la ingestión. Gemini sigue funcionando por sí solo.

## Fuentes oficiales verificadas

- Groq: modelos, límites Free y rate-limit headers: <https://console.groq.com/docs/rate-limits>
- Groq: compatibilidad OpenAI: <https://console.groq.com/docs/openai>
- Groq: Structured Outputs / JSON Schema (`strict: true` en GPT-OSS 20B/120B): <https://console.groq.com/docs/structured-outputs>
- Groq: reasoning (`include_reasoning` y `reasoning_effort` en GPT-OSS; `none` en Qwen 3.8): <https://console.groq.com/docs/reasoning>
- Groq: API reference (`reasoning_effort`): <https://console.groq.com/docs/api-reference>
- Mistral: Free mode y primer request: <https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request>
- Mistral Chat Completions (`json_object` y `json_schema`): <https://docs.mistral.ai/api>
- Mistral custom structured outputs (ejemplo Ministral 8B): <https://docs.mistral.ai/capabilities/structured_output/custom>
- Mistral rate limits (RPS y TPM independientes; `X-RateLimit-Remaining`): <https://docs.mistral.ai/resources/known-limitations>
- Mistral `service_tier=standard_only`: <https://docs.mistral.ai/inference/priority-tier>
- Mistral 429 en Free mode: <https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them>
- Z.AI: thinking (default on en GLM-4.7; `thinking.type=disabled`): <https://docs.z.ai/guides/capabilities/thinking-mode>
- Z.AI: parámetros, incluido `thinking`: <https://docs.z.ai/guides/overview/concept-param>
- Z.AI: JSON mode / structured output (`json_object`, no json_schema): <https://docs.z.ai/guides/capabilities/struct-output>
- Z.AI: Chat Completions: <https://docs.z.ai/api-reference/llm/chat-completion>
- Z.AI: códigos de error (`1302` concurrency; `1305` overload/capacity, HTTP 429; `1303`/`1304` no oficiales): <https://docs.z.ai/api-reference/api-code>
- Z.AI: GLM-4.7 (incluye Flash): <https://docs.z.ai/guides/llm/glm-4.7>
- Z.AI: GLM-4.5 / Flash y structured output: <https://docs.z.ai/guides/llm/glm-4.5>
- Z.AI: precios por modelo: <https://docs.z.ai/guides/overview/pricing>
- Z.AI: endpoint general: <https://docs.z.ai/guides/develop/http/introduction>
- Cloudflare: Free frente a Paid: <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- Cloudflare: endpoint OpenAI-compatible: <https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>
- Cloudflare: errores, incluido `3036`: <https://developers.cloudflare.com/workers-ai/platform/errors/>
- Cloudflare JSON Mode (allowlist de modelos): <https://developers.cloudflare.com/workers-ai/features/json-mode/>
- Cloudflare `@cf/zai-org/glm-4.7-flash` (`max_completion_tokens`, `reasoning_effort`, `chat_template_kwargs`, `response_format`): <https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/>
- Cloudflare `@cf/google/gemma-4-26b-a4b-it`: <https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/>
- Gemini thinking (`thinking_level`): <https://ai.google.dev/gemini-api/docs/thinking>
