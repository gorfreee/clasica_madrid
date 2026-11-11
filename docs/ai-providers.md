# Pool de IA gratuito

Producción usa un pool ordenado de routes `provider:model`. Gemini conserva la prioridad inicial; Groq, Cloudflare Workers AI, Z.AI y OpenRouter aportan capacidad adicional. Mistral está suspendido por facturación no verificada; Kilo y Vercel no tienen modelos aprobados activos. La primera respuesta que supera el schema del purpose termina la llamada. No hay voting, consensus ni llamadas duplicadas tras un resultado válido.

## Garantía operativa de coste cero

El workflow declara `AI_ZERO_COST_ONLY=true`. Con esa política:

- OpenAI queda fuera del pool de producción y sólo se conserva como integración manual legacy;
- Groq exige `GROQ_FREE_TIER_CONFIRMED=true` además de su key;
- Mistral está suspendido en el factory de coste cero, incluso con `MISTRAL_FREE_MODE_CONFIRMED=true`, overrides o una route fijada; véase la revisión de facturación más abajo;
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
5. Mistral: suspendido; sin routes;
6. Cloudflare Workers AI: `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/openai/gpt-oss-20b`;
7. Z.AI: `glm-4.7-flash`, `glm-4.6v-flash`, `glm-4.5-flash`;
8. Kilo: sin modelos aprobados;
9. OpenRouter: `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`.

Vercel conserva la integración, pero desde 2026-09-29 no tiene ninguna route por defecto: `inclusionai/ling-3.0-flash-vl-free` responde 404 indicando que terminó su free tier. No se sustituye por el ID de pago ni por crédito promocional.

Quarantined de OpenRouter (allowlist de diagnóstico, **fuera** del pool por defecto):

- `openrouter:openai/gpt-oss-20b:free` — variante free no disponible; nunca se sustituye por el ID pagado;
- `openrouter:inclusionai/ling-3.0-flash-vl:free` — el endpoint de inferencia responde que ya no está disponible gratis mientras el catálogo público puede ir retrasado.

Kilo ya no mantiene modelos quarantined: Dots3 se elimina incluso de diagnóstico porque su ventana gratuita documentada termina el 2026-09-30. Nex N2.5 Mini/Pro y Ling 3.0 VL se eliminan del pool tras 404 live. No se añaden nuevos modelos de Kilo procedentes de inventario promocional/dinámico.

La política para **nuevas** incorporaciones es conservadora: sólo se añaden modelos que el proveedor documenta como gratuitos o cubiertos por el Free mode establecido, sin fecha de expiración publicada ni lenguaje de promoción temporal. Que hoy un modelo tenga precio $0 no basta. Esto no implica una garantía eterna: los catálogos externos pueden cambiar y el live smoke sigue siendo la comprobación operativa.

Cada lista puede reordenarse con `*_MODELS`. Unset significa «usar el default versionado en Git». En zero-cost mode, Z.AI, Cloudflare, Gemini, Vercel, Kilo y OpenRouter rechazan IDs fuera de su allowlist.

### Mistral: suspensión por facturación (2026-11-11)

La [documentación actual de uso y límites](https://docs.mistral.ai/admin/billing-usage/usage-limits) indica que Free mode no incluye API y que usarla requiere activar facturación/PAYG. El [quickstart](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key) conserva instrucciones sobre Free mode, mientras [Subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions) describe presupuestos incluidos y PAYG. Esta información pública no demuestra el contrato de esta organización. El HTTP 200 del smoke tampoco demuestra ausencia de cargos.

Por eso el factory devuelve cero routes Mistral, sin intentar HTTP, y la inspección declara `disabled` con el motivo. La confirmación antigua no reactiva el proveedor. Se conservan los perfiles de transporte y los límites históricos de septiembre para una futura revisión; no son límites actuales verificados ni capacidad activa del pool.

Antes de reactivar mediante una PR hay que verificar en **la organización que posee la key**: plan/contrato aplicable al API, estado de PAYG y recarga automática, presupuesto realmente gratuito (no créditos comprados o temporales), corte duro al agotarlo y uso/costes correspondientes al smoke del 10-11-2026. No publicar keys, datos de pago ni facturas completas. Si el API exige facturación pagada, mantenerlo fuera del pool. Revalidar también los límites de cuenta; no reutilizar las cuotas de septiembre sin evidencia actual.

Esta PR no accede al dashboard ni certifica cargos históricos: establece una protección conservadora mientras esa evidencia no esté disponible. La contrapartida es perder temporalmente tres rutas de fallback funcionales.

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
| Mistral `ministral-14b-2512`, `8b`, `3b` | `json_schema`, `strict: true` | no se envía | `max_tokens` | Perfil histórico suspendido; `service_tier=standard_only`. |
| Z.AI `glm-4.7-flash`, `glm-4.6v-flash`, `glm-4.5-flash` | `json_object` | `thinking.type=disabled` | `max_tokens` | JSON mode + validación local. |
| Cloudflare GLM/Gemma | sin `response_format` | thinking desactivado con los flags documentados para esos IDs | `max_completion_tokens` | Prompt + validación local; no están en la allowlist oficial de JSON Mode. |
| `cloudflare:@cf/openai/gpt-oss-20b` | sin `response_format` | no se envían flags GLM/Gemma | `max_tokens` | Profile separado para no mandar parámetros no documentados. |
| OpenRouter Gemma 4 26B / 31B Free | `json_object` | `reasoning.effort=none` | `max_tokens` | `provider.require_parameters=true`. |
| OpenRouter quarantined | conserva el profile histórico | según cada ID | `max_tokens` | Sólo diagnóstico explícito; no participa en el default. |


## Vercel AI Gateway (revisado 2026-09-29)

Endpoint OpenAI-compatible: `https://ai-gateway.vercel.sh/v1`.

**No hay ninguna route activa por defecto.** El live smoke de 2026-09-29 devolvió 404 para `inclusionai/ling-3.0-flash-vl-free` con un mensaje explícito de que su free tier había terminado. El sibling de pago no se usa. Tampoco se consideran los $5 promocionales del Gateway como coste cero estable.

La integración y las variables `VERCEL_*` se conservan para poder reactivar el provider si aparece en el futuro un modelo explícitamente $0 que cumpla la política de estabilidad.

## Kilo AI Gateway (revisado 2026-11-11)

Endpoint OpenAI-compatible: `https://api.kilo.ai/api/gateway`. Secret: `KILO_API_KEY`. Confirmación: `KILO_FREE_TIER_CONFIRMED=true`.

Sin default activo: `poolside/laguna-xs-2.1:free` devolvió 404 `model_not_found` en el [run 42885832706](https://github.com/gorfreee/clasica_madrid/actions/runs/42885832706). Se retira tanto de la allowlist activa como de diagnóstico; no se sustituye por un modelo pagado o promocional.

Retirados después del smoke live:

- `nex-agi/nex-n2.5-mini:free` — 404 `model_not_found`;
- `nex-agi/nex-n2.5-pro:free` — 404 `model_not_found`;
- `inclusionai/ling-3.0-flash-vl:free` — 404 `model_not_found`;
- `dots-studio/dots-3-note-preview:free` — eliminado también del diagnóstico porque la ventana gratuita documentada finaliza el 2026-09-30.

No se añaden sustitutos nuevos desde Kilo en esta revisión: su catálogo gratuito se documenta como dinámico y sujeto a disponibilidad/promociones, por lo que no cumple el criterio pedido para **nuevas** incorporaciones estables. `kilo-auto/free`, modelos sin `:free`, BYOK y fallbacks pagados siguen excluidos.

El límite documentado de modelos gratuitos se trata como compartido por provider, no por route. Producción mantiene `providerMaxConcurrent=1` y `providerMinIntervalMs=20_000`.

## OpenRouter (revisado 2026-11-11)

Endpoint OpenAI-compatible: `https://openrouter.ai/api/v1`. Secret: `OPENROUTER_API_KEY`. Confirmación: `OPENROUTER_FREE_TIER_CONFIRMED=true`.

Allowlist activa:

- `google/gemma-4-26b-a4b-it:free`;
- `google/gemma-4-31b-it:free`.

Gemma 4 31B Free se añade porque OpenRouter lo publica como endpoint gratuito sin aviso de promoción temporal conocido. Esto es el criterio de entrada, no una promesa de permanencia: el smoke seguirá detectando cualquier cambio posterior.

Se evaluó `nvidia/nemotron-3-super-120b-a12b:free`, pero **se excluye**: aunque OpenRouter lo presenta a precio $0, la propia página del endpoint remite a los NVIDIA API Trial Terms. Bajo la política estable-only del proyecto, "trial" es suficiente para no incorporarlo.

Retirado del default:

- `poolside/laguna-xs-2.1:free` — sin proveedor disponible en el smoke del 10-11-2026; también queda fuera del diagnóstico. El [catálogo oficial](https://openrouter.ai/models?variant=free) lo marca como deprecated aunque páginas indexadas pueden estar desactualizadas.

- `nex-agi/nex-n2.5-mini:free` — el endpoint informa que la disponibilidad gratuita terminó.

Quarantined:

- `openai/gpt-oss-20b:free` — variante free no disponible; se conserva sólo para diagnóstico;
- `inclusionai/ling-3.0-flash-vl:free` — 404 indicando que no está disponible gratis, con posible retraso del catálogo público.

`openrouter/free`, IDs sin `:free`, fallback automático a variantes pagadas y BYOK siguen excluidos. El body usa `provider: { require_parameters: true }` para restringir el routing a endpoints que aceptan los parámetros enviados.

Los [límites oficiales](https://openrouter.ai/pricing) son 20 RPM y 50 RPD compartidos entre modelos `:free`; 1.000 RPD requieren el historial de compra de créditos aplicable. Los intentos fallidos también cuentan. Sin evidencia de esa cuenta, el default es `providerRpd=50` y `providerMinIntervalMs=3_200`.

`OPENROUTER_HIGHER_FREE_LIMIT_CONFIRMED=true` sólo debe activarse tras verificar el historial/allowance de la cuenta propietaria de la key. Entonces el techo agregado pasa a 1.000; no autoriza comprar créditos ni usar modelos pagados. `OPENROUTER_RPD` permite reducir el límite (incluido 0), pero queda limitado al techo confirmado: un override antiguo de 1.000 sin esta nueva confirmación se recorta a 50. Los contadores persistidos se conservan y suman por provider, incluso si desaparece una route. El smoke/qualification directo sigue sin compartir ese ledger productivo: también consume la cuota real de la cuenta.

Guardrail recomendado: reflejar la allowlist activa del código (`google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`).

Un HTTP 402 se clasifica como `unavailable`; 401/403 como `auth`; 429 como presión/rate-limit. Nunca se reescribe un ID free al sibling pagado.

Un 1305 de Z.AI se clasifica como `capacity` / `PROVIDER_BUSY`. Un `1302` es presión de concurrencia. El live smoke puede reintentar una vez sólo fallos transitorios; esto no cambia la política del pool productivo.

`--ai-max-requests` limita los HTTP requests del pool completo. `--ai-route provider:model` fija una route exacta para diagnóstico.

El `report.json`, el resumen de consola y el Job Summary separan provider, modelo y `routeId`, incluyendo retries, fallbacks, rate limits, concurrency-pressure, cuotas y circuit breakers.

## Smoke tests manuales

Son llamadas **live** a las APIs de los proveedores: consumen quota real. No se ejecutan automáticamente en CI (ni en push ni en pull request), no escriben `data/**` y no crean PRs. Conviene lanzarlos tras cambiar providers, modelos, transports o prompts, o cuando una ingestión muestre comportamientos sospechosos.

Descubren las routes con la misma configuración que el pool de producción (`inspectFreePoolFromEnv`) y reutilizan directamente cada transport, payload, prompt, schema y parser real. El runner llama a `route.transport.request()` por celda **sin** pool, fallback, cache, scheduler, circuit breaker ni estado persistente. Como máximo **un retry** y **sólo** si el fallo es claramente transitorio:

- timeout;
- 429 de frecuencia/capacidad (RPM, TPM, OTPM, concurrency, provider-busy, rate-limit indeterminado);
- ciertos 5xx / `retryable`.

Fuera de Gemini, se respeta el mayor `retryAfterMs` / `resetAfterMs` interpretado por el transporte, con mínimo 1,5 s y pacing de route/provider. Una espera requerida superior a 30 s se registra como `retryDeferredMs`, conservando el resultado transitorio sin reintento prematuro; se bloquean también los purposes restantes de esa route con salud DEGRADED y cero HTTP. Por celda hay como máximo dos timeouts HTTP y una espera acotada, además del pacing compartido. Gemini conserva su retry previo de 1,5 s sin ningún cambio de configuración, modelos o transporte.

El JSON del smoke pasa a `schemaVersion=3`: cada celda solicitada añade `lastAttemptLatencyMs` y `totalElapsedMs` (todos los intentos y esperas desde el primer HTTP; excluye la espera inicial de cola). Fuera de Gemini, `latencyMs` y SLOW usan ese total; Gemini conserva su significado legacy de último intento y ofrece el total en el campo nuevo. La tabla de diagnóstico muestra ambos para evitar confundir una respuesta rápida tras retry con una ruta rápida. El total de la run es tiempo de pared con concurrencia, no la suma de todas las rutas.

**No** hay retry para auth, 400/bad-request, parámetros no soportados, 404/modelo inexistente, schema inválido, output vacío/inválido, output-limit, cuota diaria ni riesgo de ruta de pago. Un proveedor activo esperado sin key o sin confirmación gratuita cuenta como FAIL. Un proveedor suspendido por política o con allowlist intencionadamente vacía aparece en `disabledProviders` / «Disabled providers», sin HTTP ni FAIL artificial. Una selección explícita inválida sigue fallando; no se ocultan errores de configuración. Qualification tampoco genera fallos sintéticos por esos proveedores suspendidos.

Cada celda y cada route reciben una salud simple:

- `HEALTHY` — `PASS` o `SLOW` (JSON válido y semántica esperada);
- `DEGRADED` — saturación o fallo transitorio del provider (429 de capacidad/frecuencia, timeout, 5xx);
- `FAIL` — error determinista de integración/configuración (auth, 404, 400, schema, output vacío, output-limit, cuota diaria, modelo de pago rechazado).

Los modelos quarantined de OpenRouter (GPT-OSS Free y Ling 3.0 Flash VL Free) aparecen como `QUARANTINED: N` en el resumen del provider; no se mezclan con un FAIL live salvo que se activen a propósito y fallen.

El timeout productivo del pool sigue en 15 s. El **live smoke** usa un hard timeout de 30 s y marca como `SLOW` (sigue siendo PASS funcional / HEALTHY) cualquier respuesta correcta ≥ 15 s. Un corte a 30 s es `TIMEOUT` / DEGRADED. `--timeout-ms` / `--slow-threshold-ms` (o `AI_SMOKE_TIMEOUT_MS` / `AI_SMOKE_SLOW_THRESHOLD_MS`) permiten override explícito.

Por defecto prueba un solo purpose (`eligibility`, hasta dos HTTP por route con retry transitorio). `--purpose taxonomy` cambia el fixture; `--all-purposes` recorre eligibility, composer extraction, access y taxonomy (hasta dos HTTP por `route × purpose` con retry transitorio). Cada fixture declara una expectativa semántica mínima y no ambigua; no basta con devolver JSON compatible.

Los providers avanzan en paralelo. Dentro de cada provider hay como máximo dos workers —o menos si `providerMaxConcurrent` es más restrictivo—, cada route mantiene un único request en vuelo y los inicios respetan sus `rpm` / `minIntervalMs` y el `providerMinIntervalMs`. Un fallo funcional, output inválido, timeout, `SLOW` o 429 transitorio no impide probar los demás purposes. Auth, modelo inequívocamente inexistente/no disponible y cuota diaria explícitamente agotada bloquean los purposes restantes de esa route; una espera diferida por encima del presupuesto también los bloquea para respetar el cooldown.

```bash
# una sola route (eligibility)
npm run ai:smoke -- --route groq:openai/gpt-oss-120b
npm run ai:smoke -- --route zai:glm-4.7-flash
npm run ai:smoke -- --route zai:glm-4.6v-flash
npm run ai:smoke -- --route cloudflare:@cf/zai-org/glm-4.7-flash
npm run ai:smoke -- --route cloudflare:@cf/openai/gpt-oss-20b
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
npm run ai:qualify -- --route groq:openai/gpt-oss-120b --max-cases 8 --report-dir /tmp/ai-qualify-report
```

Coste aproximado: `casos × routes` HTTP. `core` × pool por defecto ≈ 17 × N; `full` ≈ 32 × N. Gemini flash declara RPD 18: `full` puede terminar en `daily-quota` en esos models; no se oculta con fallback. Timeout del workflow: 60 min. Hard timeout por request: 30 s, igual que el smoke, sin retries.

El Job Summary (y `ai-qualify-report.md` / `ai-qualify-report.json`) separa transporte, contrato, semántica y evidence grounded. El ranking por purpose es informativo: semántica → evidence → schema → transporte → p50 → tokens de salida. Una muestra insuficiente se marca. El JSON guarda timestamp, commit SHA, dataset id, contract/prompt versions y la config de la run para comparar ejecuciones.

Workflow manual: **AI live qualification** (`.github/workflows/ai-live-qualification.yml`).

## Checklist después del merge

1. Añadir el secret `GROQ_API_KEY`.
2. Confirmar en Groq que la organización sigue en Free tier.
3. Añadir la repository/environment variable `GROQ_FREE_TIER_CONFIRMED=true`.
4. Mantener Mistral suspendido hasta completar la verificación de facturación descrita arriba. La key y confirmación antiguas no autorizan llamadas. No hace falta borrar credenciales para aplicar esta protección.
7. Confirmar que siguen existiendo los secrets `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
8. No crear nuevas credenciales Cloudflare.
9. Añadir únicamente `CLOUDFLARE_WORKERS_FREE_CONFIRMED=true` como repository/environment variable, tras confirmar Workers Free.
10. Añadir el secret `ZAI_API_KEY`.
11. Verificar que `ZAI_MODELS` sólo contiene modelos explícitamente gratuitos; por defecto no hace falta crear esta variable.
12. Vercel no necesita credenciales para el pool por defecto mientras `VERCEL_ZERO_COST_MODELS` esté vacío; si se conservan, el crédito promocional de $5 sigue sin autorizar modelos de pago.
13. Kilo no necesita credenciales mientras no tenga modelos aprobados. Retirar `KILO_MODELS` si aún selecciona Laguna; una selección explícita retirada se rechaza.
14. Añadir el secret `OPENROUTER_API_KEY` y `OPENROUTER_FREE_TIER_CONFIRMED=true`. Retirar Laguna de cualquier `OPENROUTER_MODELS` explícito y del guardrail externo. Mantener el techo de 50 RPD salvo verificación actual y confirmación del nivel superior. Opcional pero recomendado: Guardrail de OpenRouter con la misma allowlist que el código.
15. No hace falta crear `VERCEL_MODELS` / `KILO_MODELS` / `OPENROUTER_MODELS` ni overrides de límites: los defaults viven en el código.
16. Ejecutar `npm run ai:smoke:all` (y `--all-purposes` si cambian las tasks), una route concreta con `npm run ai:smoke -- --route …`, o usar el workflow **AI live smoke test**: `route` vacío cubre el barrido completo y `provider:model` aísla una route. Un HTTP smoke en verde **no** modifica las prioridades del pool.
17. Ejecutar **AI live qualification** (`npm run ai:qualify -- --providers kilo,openrouter`) contra el mismo dataset de producción antes de reordenar esas rutas (Kilo no tiene modelos activos).
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
