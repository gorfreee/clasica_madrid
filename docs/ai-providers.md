# Pool de IA gratuito

Producción usa un pool ordenado de routes `provider:model`. Gemini conserva la prioridad inicial; Groq, Mistral, Cloudflare Workers AI y Vercel AI Gateway aportan capacidad adicional. Z.AI, Kilo AI Gateway y OpenRouter siguen después. La primera respuesta que supera el schema del purpose termina la llamada. No hay voting, consensus ni llamadas duplicadas tras un resultado válido.

## Garantía operativa de coste cero

El workflow declara `AI_ZERO_COST_ONLY=true`. Con esa política:

- OpenAI queda fuera del pool de producción y sólo se conserva como integración manual legacy;
- Groq exige `GROQ_FREE_TIER_CONFIRMED=true` además de su key;
- Mistral exige `MISTRAL_FREE_MODE_CONFIRMED=true`; la cuenta debe seguir en Free mode y PAYG debe estar desactivado;
- Z.AI sólo admite `glm-4.7-flash` y `glm-4.5-flash`;
- Cloudflare sólo admite la allowlist versionada, exige `CLOUDFLARE_WORKERS_FREE_CONFIRMED=true` y llama directamente a Workers AI, nunca a AI Gateway;
- Vercel exige `VERCEL_FREE_TIER_CONFIRMED=true` y sólo IDs de la allowlist con precio documentado $0. El crédito promocional de $5 **no** forma parte de esta garantía;
- Kilo exige `KILO_FREE_TIER_CONFIRMED=true` y sólo IDs explícitos `:free` de la allowlist. `kilo-auto/free` queda fuera;
- OpenRouter exige `OPENROUTER_FREE_TIER_CONFIRMED=true` y sólo IDs explícitos `:free` de la allowlist. El saldo comprado **nunca** autoriza un modelo de pago. `openrouter/free` queda fuera;
- una route no demostrablemente autorizada se omite o hace fallar la configuración antes del primer HTTP request.

La confirmación de Cloudflare significa que la cuenta permanece en **Workers Free**. Workers Free corta las llamadas al agotar la asignación diaria; Workers Paid cobra automáticamente el exceso y por tanto no cumple esta política. El error Workers AI `3036` se registra como asignación diaria agotada y bloquea esas routes hasta el reset UTC.

Los modelos y condiciones de Gemini, Groq, Mistral, Z.AI y Cloudflare se verificaron en documentación oficial el 12-09-2026. Vercel, Kilo y OpenRouter se re-verificaron contra el catálogo live el 15-09-2026. Los proveedores pueden cambiar su oferta: antes de actualizar una allowlist o confirmar de nuevo un plan, hay que volver a comprobarla. La seguridad prima sobre la disponibilidad.

### Cómo se mantiene la allowlist gratuita

La lista es **explícita y manual**. No hay discovery periódico, manifest dinámico, qualification automática ni cron de revalidación.

1. Consultar el catálogo live del provider (`GET` de modelos / página oficial).
2. Comprobar que input y output son **$0 ahora**, no un crédito promocional ni un ID gemelo de pago.
3. Comprobar capacidades (JSON / reasoning / tamaño) para clasificación y extracción corta.
4. Añadir el ID exacto al array versionado (`VERCEL_ZERO_COST_MODELS`, `KILO_ZERO_COST_MODELS`, `OPENROUTER_ZERO_COST_MODELS`) y su profile HTTP.
5. Si un ID deja de ser gratuito o 404, sacarlo del default. Si sigue siendo útil para diagnóstico, moverlo a `*_QUARANTINED_MODELS` (allowlist, no pool). **Nunca** reescribir `:free` / `-free` al ID de pago.

Fail-closed: con `AI_ZERO_COST_ONLY=true`, un ID fuera de la allowlist, sin sufijo `:free` en Kilo/OpenRouter, o sin confirmación de free tier, hace fallar la configuración **antes** del primer HTTP. `kilo-auto/free` y `openrouter/free` no se activan: no podemos garantizar el modelo real ni que no deriven a una ruta inadecuada.


## Orden y configuración

Los defaults del pool, en orden, son:

1. routes Gemini ya configuradas;
2. `groq:openai/gpt-oss-120b`;
3. `groq:qwen/qwen3.8-27b`;
4. `groq:openai/gpt-oss-20b`;
5. Mistral: `ministral-14b-2512`, `ministral-8b-2512`, `ministral-3b-2512`;
6. Cloudflare Workers AI: `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/openai/gpt-oss-20b`;
7. Z.AI: `glm-4.7-flash`, `glm-4.6v-flash`, `glm-4.5-flash`;
8. Kilo: `poolside/laguna-xs-2.1:free`;
9. OpenRouter: `google/gemma-4-26b-a4b-it:free`, `poolside/laguna-xs-2.1:free`, `google/gemma-4-31b-it:free`.

Vercel conserva la integración, pero desde 2026-09-29 no tiene ninguna route por defecto: `inclusionai/ling-3.0-flash-vl-free` responde 404 indicando que terminó su free tier. No se sustituye por el ID de pago ni por crédito promocional.

Quarantined de OpenRouter (allowlist de diagnóstico, **fuera** del pool por defecto):

- `openrouter:openai/gpt-oss-20b:free` — variante free no disponible; nunca se sustituye por el ID pagado;
- `openrouter:inclusionai/ling-3.0-flash-vl:free` — el endpoint de inferencia responde que ya no está disponible gratis mientras el catálogo público puede ir retrasado.

Kilo ya no mantiene modelos quarantined: Dots3 se elimina incluso de diagnóstico porque su ventana gratuita documentada termina el 2026-09-30. Nex N2.5 Mini/Pro y Ling 3.0 VL se eliminan del pool tras 404 live. No se añaden nuevos modelos de Kilo procedentes de inventario promocional/dinámico.

La política para **nuevas** incorporaciones es conservadora: sólo se añaden modelos que el proveedor documenta como gratuitos o cubiertos por el Free mode establecido, sin fecha de expiración publicada ni lenguaje de promoción temporal. Que hoy un modelo tenga precio $0 no basta. Esto no implica una garantía eterna: los catálogos externos pueden cambiar y el live smoke sigue siendo la comprobación operativa.

Cada lista puede reordenarse con `*_MODELS`. Unset significa «usar el default versionado en Git». En zero-cost mode, Z.AI, Cloudflare, Gemini, Vercel, Kilo y OpenRouter rechazan IDs fuera de su allowlist.

Los defaults de Mistral son IDs versionados, no aliases `latest`. Para 14B/8B se conservan los límites observados en **esta** organización de Clásica Madrid en septiembre de 2026; no son cuotas universales:

| Modelo | TPM real observado | RPS real observado | Default en código |
|---|---:|---:|---|
| `ministral-14b-2512` | 937.500 | 0,50 | `tpm` 937500, `maxConcurrent` 1, `minIntervalMs` 2100 |
| `ministral-8b-2512` | 625.000 | 3,13 | `tpm` 625000, `maxConcurrent` 1, `minIntervalMs` 350 |
| `ministral-3b-2512` | no fijado en código | no fijado en código | usa los límites reales de cuenta/provider; no se inventa una cuota |

`mistral-small-latest` no es default de producción: en esta cuenta el backing model observado tenía 20.000 TPM / 1 RPS.

Z.AI mantiene `providerMaxConcurrent=1` porque el código `1302` representa presión de concurrencia, no cuota diaria ni clave inválida. Cloudflare no recibe RPM/RPD inventados; comparte la asignación gratuita de Workers AI. Kilo mantiene su límite compartido conservador y OpenRouter mantiene sus límites agregados de modelos `:free`.

Los `*_MODELS` / `*_MODEL_RPM` / `*_MODEL_TPM` / `*_MODEL_RPD` y controles de presión son configuración no sensible. En producción el workflow puede leerlos de `vars.*` como **override opcional**. Si una variable está vacía o ausente se aplican los defaults de código. En local viven en `.local/ai.env`.

El scheduler entiende límites genéricos de presión por route/provider. El profile/transport interpreta códigos y headers; la reacción (cooldown, cap de concurrencia, reporting) es genérica.

| Control en la route | Env | Significado |
|---|---|---|
| `maxConcurrent` | `*_MODEL_MAX_CONCURRENT` | HTTP simultáneos de esa route |
| `minIntervalMs` | `*_MODEL_MIN_INTERVAL_MS` | separación mínima entre comienzos de requests de esa route |
| `providerMaxConcurrent` | `*_MAX_CONCURRENT` | límite agregado de HTTP in-flight del provider |
| `providerMinIntervalMs` | `*_MIN_INTERVAL_MS` | separación agregada entre comienzos de requests del provider |
| `providerRpd` | `*_RPD` | cuota diaria agregada del provider; `0` deshabilita |

Durante una ejecución, una route que acumula varios fallos consecutivos relevantes sin un resultado válido abre un circuit breaker in-memory. Rate limits, cuotas y presión siguen sus mecanismos propios. El circuito no se persiste entre runs y nunca introduce un provider de pago.


## Perfiles HTTP por modelo

Las tareas del pool piden JSON corto. Cada route declara sus capacidades en `openaiCompatibleModelProfile` / `geminiModelProfile`; el transport no adivina flags. Timeout productivo: 15 s. El live smoke usa 30 s.

| Route | Structured output | Reasoning / thinking | Tokens | Nota |
|---|---|---|---|---|
| Gemini Flash / Gemma configurados | schema del purpose en Interactions API | según el profile Gemini existente | `max_output_tokens` | Sin cambios en esta revisión. |
| Groq GPT-OSS 20B/120B | `json_schema`, `strict: true` | `reasoning_effort: low`, output reasoning oculto | `max_tokens` | Constrained decoding documentado. |
| `groq:qwen/qwen3.8-27b` | `json_schema`, `strict: false` | `reasoning_effort: none` | `max_tokens` | Best-effort conservador. |
| Mistral `ministral-14b-2512`, `8b`, `3b` | `json_schema`, `strict: true` | no se envía | `max_tokens` | `service_tier=standard_only`. |
| Z.AI `glm-4.7-flash`, `glm-4.6v-flash`, `glm-4.5-flash` | `json_object` | `thinking.type=disabled` | `max_tokens` | JSON mode + validación local. |
| Cloudflare GLM/Gemma | sin `response_format` | thinking desactivado con los flags documentados para esos IDs | `max_completion_tokens` | Prompt + validación local; no están en la allowlist oficial de JSON Mode. |
| `cloudflare:@cf/openai/gpt-oss-20b` | sin `response_format` | no se envían flags GLM/Gemma | `max_tokens` | Profile separado para no mandar parámetros no documentados. |
| `kilo:poolside/laguna-xs-2.1:free` | sin `response_format` | `reasoning.effort=none` | `max_tokens` | Única route Kilo activa. |
| OpenRouter Gemma 4 26B / 31B Free | `json_object` | `reasoning.effort=none` | `max_tokens` | `provider.require_parameters=true`. |
| `openrouter:poolside/laguna-xs-2.1:free` | sin `response_format` | `reasoning.effort=none` | `max_tokens` | Prompt + validación local. |
| OpenRouter quarantined | conserva el profile histórico | según cada ID | `max_tokens` | Sólo diagnóstico explícito; no participa en el default. |


## Vercel AI Gateway (revisado 2026-09-29)

Endpoint OpenAI-compatible: `https://ai-gateway.vercel.sh/v1`.

**No hay ninguna route activa por defecto.** El live smoke de 2026-09-29 devolvió 404 para `inclusionai/ling-3.0-flash-vl-free` con un mensaje explícito de que su free tier había terminado. El sibling de pago no se usa. Tampoco se consideran los $5 promocionales del Gateway como coste cero estable.

La integración y las variables `VERCEL_*` se conservan para poder reactivar el provider si aparece en el futuro un modelo explícitamente $0 que cumpla la política de estabilidad.

## Kilo AI Gateway (revisado 2026-09-29)

Endpoint OpenAI-compatible: `https://api.kilo.ai/api/gateway`. Secret: `KILO_API_KEY`. Confirmación: `KILO_FREE_TIER_CONFIRMED=true`.

Default activo:

- `poolside/laguna-xs-2.1:free`.

Retirados después del smoke live:

- `nex-agi/nex-n2.5-mini:free` — 404 `model_not_found`;
- `nex-agi/nex-n2.5-pro:free` — 404 `model_not_found`;
- `inclusionai/ling-3.0-flash-vl:free` — 404 `model_not_found`;
- `dots-studio/dots-3-note-preview:free` — eliminado también del diagnóstico porque la ventana gratuita documentada finaliza el 2026-09-30.

No se añaden sustitutos nuevos desde Kilo en esta revisión: su catálogo gratuito se documenta como dinámico y sujeto a disponibilidad/promociones, por lo que no cumple el criterio pedido para **nuevas** incorporaciones estables. `kilo-auto/free`, modelos sin `:free`, BYOK y fallbacks pagados siguen excluidos.

El límite documentado de modelos gratuitos se trata como compartido por provider, no por route. Producción mantiene `providerMaxConcurrent=1` y `providerMinIntervalMs=20_000`.

## OpenRouter (revisado 2026-09-29)

Endpoint OpenAI-compatible: `https://openrouter.ai/api/v1`. Secret: `OPENROUTER_API_KEY`. Confirmación: `OPENROUTER_FREE_TIER_CONFIRMED=true`.

Allowlist activa:

- `google/gemma-4-26b-a4b-it:free`;
- `poolside/laguna-xs-2.1:free`;
- `google/gemma-4-31b-it:free`.

Gemma 4 31B Free se añade porque OpenRouter lo publica como endpoint gratuito sin aviso de promoción temporal conocido. Esto es el criterio de entrada, no una promesa de permanencia: el smoke seguirá detectando cualquier cambio posterior.

Se evaluó `nvidia/nemotron-3-super-120b-a12b:free`, pero **se excluye**: aunque OpenRouter lo presenta a precio $0, la propia página del endpoint remite a los NVIDIA API Trial Terms. Bajo la política estable-only del proyecto, "trial" es suficiente para no incorporarlo.

Retirado del default:

- `nex-agi/nex-n2.5-mini:free` — el endpoint informa que la disponibilidad gratuita terminó.

Quarantined:

- `openai/gpt-oss-20b:free` — variante free no disponible; se conserva sólo para diagnóstico;
- `inclusionai/ling-3.0-flash-vl:free` — 404 indicando que no está disponible gratis, con posible retraso del catálogo público.

`openrouter/free`, IDs sin `:free`, fallback automático a variantes pagadas y BYOK siguen excluidos. El body usa `provider: { require_parameters: true }` para restringir el routing a endpoints que aceptan los parámetros enviados.

La cuenta mantiene el límite agregado documentado de modelos gratuitos ya modelado por el proyecto: `providerRpd=1000` y `providerMinIntervalMs=3_200`. El saldo pagado nunca autoriza una route de pago.

Guardrail recomendado: reflejar la allowlist activa del código (`google/gemma-4-26b-a4b-it:free`, `poolside/laguna-xs-2.1:free`, `google/gemma-4-31b-it:free`).

Un HTTP 402 se clasifica como `unavailable`; 401/403 como `auth`; 429 como presión/rate-limit. Nunca se reescribe un ID free al sibling pagado.

Un 1305 de Z.AI se clasifica como `capacity` / `PROVIDER_BUSY`. Un `1302` es presión de concurrencia. El live smoke puede reintentar una vez sólo fallos transitorios; esto no cambia la política del pool productivo.

`--ai-max-requests` limita los HTTP requests del pool completo. `--ai-route provider:model` fija una route exacta para diagnóstico.

El `report.json`, el resumen de consola y el Job Summary separan provider, modelo y `routeId`, incluyendo retries, fallbacks, rate limits, concurrency-pressure, cuotas y circuit breakers.

## Smoke tests manuales

Son llamadas **live** a las APIs de los proveedores: consumen quota real. No se ejecutan automáticamente en CI (ni en push ni en pull request), no escriben `data/**` y no crean PRs. Conviene lanzarlos tras cambiar providers, modelos, transports o prompts, o cuando una ingestión muestre comportamientos sospechosos.

Descubren las routes con la misma configuración que el pool de producción (`inspectFreePoolFromEnv`) y reutilizan directamente cada transport, payload, prompt, schema y parser real. El runner llama a `route.transport.request()` por celda **sin** pool, fallback, cache, scheduler, circuit breaker ni estado persistente. Como máximo **un retry** (backoff 1,5 s) y **sólo** si el fallo es claramente transitorio:

- timeout;
- 429 de frecuencia/capacidad (RPM, TPM, OTPM, concurrency, provider-busy, rate-limit indeterminado);
- ciertos 5xx / `retryable`.

**No** hay retry para auth, 400/bad-request, parámetros no soportados, 404/modelo inexistente, schema inválido, output vacío/inválido, output-limit, cuota diaria ni riesgo de ruta de pago. Un proveedor esperado sin key o sin confirmación gratuita no desaparece: cuenta como FAIL.

Cada celda y cada route reciben una salud simple:

- `HEALTHY` — `PASS` o `SLOW` (JSON válido y semántica esperada);
- `DEGRADED` — saturación o fallo transitorio del provider (429 de capacidad/frecuencia, timeout, 5xx);
- `FAIL` — error determinista de integración/configuración (auth, 404, 400, schema, output vacío, output-limit, cuota diaria, modelo de pago rechazado).

Los modelos quarantined de OpenRouter (GPT-OSS Free y Ling 3.0 Flash VL Free) aparecen como `QUARANTINED: N` en el resumen del provider; no se mezclan con un FAIL live salvo que se activen a propósito y fallen.

El timeout productivo del pool sigue en 15 s. El **live smoke** usa un hard timeout de 30 s y marca como `SLOW` (sigue siendo PASS funcional / HEALTHY) cualquier respuesta correcta ≥ 15 s. Un corte a 30 s es `TIMEOUT` / DEGRADED. `--timeout-ms` / `--slow-threshold-ms` (o `AI_SMOKE_TIMEOUT_MS` / `AI_SMOKE_SLOW_THRESHOLD_MS`) permiten override explícito.

Por defecto prueba un solo purpose (`eligibility`, como máximo un HTTP por route). `--purpose taxonomy` cambia el fixture; `--all-purposes` recorre eligibility, composer extraction, access y taxonomy (como máximo un HTTP por `route × purpose`). Cada fixture declara una expectativa semántica mínima y no ambigua; no basta con devolver JSON compatible.

Los providers avanzan en paralelo. Dentro de cada provider hay como máximo dos workers —o menos si `providerMaxConcurrent` es más restrictivo—, cada route mantiene un único request en vuelo y los inicios respetan sus `rpm` / `minIntervalMs` y el `providerMinIntervalMs`. Un fallo funcional, output inválido, timeout, `SLOW` o 429 transitorio no impide probar los demás purposes. Sólo auth, modelo inequívocamente inexistente/no disponible y cuota diaria explícitamente agotada bloquean los purposes restantes de esa route.

```bash
# una sola route (eligibility)
npm run ai:smoke -- --route groq:openai/gpt-oss-120b
npm run ai:smoke -- --route mistral:ministral-14b-2512
npm run ai:smoke -- --route mistral:ministral-8b-2512
npm run ai:smoke -- --route mistral:ministral-3b-2512
npm run ai:smoke -- --route zai:glm-4.7-flash
npm run ai:smoke -- --route zai:glm-4.6v-flash
npm run ai:smoke -- --route cloudflare:@cf/zai-org/glm-4.7-flash
npm run ai:smoke -- --route cloudflare:@cf/openai/gpt-oss-20b
npm run ai:smoke -- --route kilo:poolside/laguna-xs-2.1:free
npm run ai:smoke -- --route openrouter:google/gemma-4-31b-it:free

# una sola route, las cuatro tasks
npm run ai:smoke -- --route groq:openai/gpt-oss-120b --all-purposes

# todas las routes, una petición de eligibility por modelo
npm run ai:smoke:all

# todas las tasks (`AI_CALL_PURPOSES`) en todas las routes
npm run ai:smoke:all -- --all-purposes

# artefactos locales (Job Summary / GitHub artifact en el workflow)
npm run ai:smoke:all -- --all-purposes --report-dir /tmp/ai-smoke-report
```

El comando carga `.local/ai.env`, fuerza `AI_ZERO_COST_ONLY=true` e imprime una línea JSON por celda más el informe Markdown. En GitHub Actions el mismo Markdown se publica en `$GITHUB_STEP_SUMMARY` y se suben `ai-smoke-report.md` / `ai-smoke-report.json` aunque el smoke falle. El informe incluye un resumen por provider (`HEALTHY` / `DEGRADED` / `FAIL` / `QUARANTINED`), la matriz por purpose, y una tabla de diagnósticos (latencia, intentos, HTTP, categoría, finish reason, output tokens, thought tokens). Los estados de celda son:

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

## Provider health

Vercel
  HEALTHY: 1
  DEGRADED: 0
  FAIL: 0

Kilo
  HEALTHY: 3
  DEGRADED: 1
  FAIL: 0
  QUARANTINED: 1

OpenRouter
  HEALTHY: 2
  DEGRADED: 1
  FAIL: 1
  QUARANTINED: 1

| Provider | Model | Eligibility | Composer | Access | Taxonomy | Health | Latency | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini | gemini-3.8-flash | TIMEOUT | PASS | SLOW | DAILY_QUOTA | FAIL | 41.0 s | PARTIAL |
| groq | openai/gpt-oss-120b | PASS | PASS | PASS | PASS | HEALTHY | 3.5 s | PASS |
```

En GitHub hay workflows manuales (`workflow_dispatch`, `contents: read`, mismos secrets/`vars` que la ingestión). No publican datos:

- **AI live smoke test** — único workflow de smoke. `route` vacío prueba todo el pool; una route exacta (`provider:model`) aísla ese modelo. `purpose` permite elegir una task concreta o `all`.
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

# un purpose, un provider (también vercel, kilo, openrouter)
npm run ai:qualify -- --suite full --purpose eligibility --providers groq
npm run ai:qualify -- --suite core --providers vercel,kilo,openrouter

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
12. Vercel no necesita credenciales para el pool por defecto mientras `VERCEL_ZERO_COST_MODELS` esté vacío; si se conservan, el crédito promocional de $5 sigue sin autorizar modelos de pago.
13. Añadir el secret `KILO_API_KEY` y `KILO_FREE_TIER_CONFIRMED=true`.
14. Añadir el secret `OPENROUTER_API_KEY` y `OPENROUTER_FREE_TIER_CONFIRMED=true`. Opcional pero recomendado: Guardrail de OpenRouter con la misma allowlist que el código.
15. No hace falta crear `VERCEL_MODELS` / `KILO_MODELS` / `OPENROUTER_MODELS` ni overrides de límites: los defaults viven en el código.
16. Ejecutar `npm run ai:smoke:all` (y `--all-purposes` si cambian las tasks), una route concreta con `npm run ai:smoke -- --route …`, o usar el workflow **AI live smoke test**: `route` vacío cubre el barrido completo y `provider:model` aísla una route. Un HTTP smoke en verde **no** promociona estas routes por delante de Gemini/Groq/Mistral/Z.AI/Cloudflare.
17. Ejecutar **AI live qualification** (`npm run ai:qualify -- --providers kilo,openrouter`) contra el mismo dataset de producción antes de reordenar esas rutas.
18. Lanzar un `workflow_dispatch` en `dry-run` antes del primer publish.

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
- Z.AI: GLM-4.6V / Flash: <https://docs.z.ai/guides/vlm/glm-4.6v>
- Z.AI: precios por modelo: <https://docs.z.ai/guides/overview/pricing>
- Z.AI: endpoint general: <https://docs.z.ai/guides/develop/http/introduction>
- Cloudflare: Free frente a Paid: <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- Cloudflare: endpoint OpenAI-compatible: <https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>
- Cloudflare: errores, incluido `3036`: <https://developers.cloudflare.com/workers-ai/platform/errors/>
- Cloudflare JSON Mode (allowlist de modelos): <https://developers.cloudflare.com/workers-ai/features/json-mode/>
- Cloudflare `@cf/zai-org/glm-4.7-flash` (`max_completion_tokens`, `reasoning_effort`, `chat_template_kwargs`, `response_format`): <https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/>
- Cloudflare `@cf/google/gemma-4-26b-a4b-it`: <https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/>
- Cloudflare `@cf/openai/gpt-oss-20b`: <https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/>
- Gemini thinking (`thinking_level`): <https://ai.google.dev/gemini-api/docs/thinking>
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway>
- Vercel autenticación: <https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication>
- Vercel modelos: <https://vercel.com/docs/ai-gateway/models-and-providers>
- Vercel OpenAI-compatible / Chat Completions: <https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-compat>
- Vercel structured outputs: <https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs>
- Vercel Ling 3.0 Flash VL Free: <https://vercel.com/ai-gateway/models/ling-3.0-flash-vl-free>
- Vercel reasoning (`reasoning.effort`, incluido `none`): <https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning>
- Kilo API / Gateway: <https://docs.kilo.ai/integrations/api>
- Kilo modelos: <https://kilo.ai/models>
- Kilo catálogo live: `GET https://api.kilo.ai/api/gateway/models`
- Kilo MiniMax M2.7 Free (página de producto; ausente del catálogo live el 2026-09-15): <https://kilo.ai/models/minimax/minimax-m2.7:free>
- OpenRouter API: <https://openrouter.ai/docs/api/reference/overview>
- OpenRouter modelos gratuitos: <https://openrouter.ai/docs/guides/routing/model-routing/free-openrouter-endpoints>
- OpenRouter catálogo live: `GET https://openrouter.ai/api/v1/models`
- OpenRouter rate limits: <https://openrouter.ai/docs/api-reference/limits>
- OpenRouter structured outputs: <https://openrouter.ai/docs/guides/features/structured-outputs>
- OpenRouter provider routing (`require_parameters`): <https://openrouter.ai/docs/guides/routing/provider-selection>
- OpenRouter reasoning (`reasoning.effort`, incluido `none`): <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- OpenRouter Guardrails: <https://openrouter.ai/docs/guides/features/guardrails>
- Gemma 4 26B A4B Free: <https://openrouter.ai/google/gemma-4-26b-a4b-it:free>
- Gemma 4 31B Free: <https://openrouter.ai/google/gemma-4-31b-it:free>
- Nemotron 3 Super 120B A12B Free (evaluado y excluido por NVIDIA API Trial Terms): <https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free>
- GPT-OSS 20B (ID de pago; la variante `:free` no está en el catálogo): <https://openrouter.ai/openai/gpt-oss-20b>
