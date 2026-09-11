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

Los modelos y condiciones se verificaron en documentación oficial el 10-09-2026. Los proveedores pueden cambiar su oferta: antes de actualizar una allowlist o confirmar de nuevo un plan, hay que volver a comprobarla. La seguridad prima sobre la disponibilidad.

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

Las tareas del pool (eligibility, compositores, acceso, taxonomy) piden JSON corto. El transport OpenAI-compatible es único; cada route declara el payload que su proveedor admite:

| Route | JSON mode | Thinking / reasoning | Notas |
|---|---|---|---|
| `groq:*` | `response_format: json_object` | no se envía | No añadir `thinking` ni `chat_template_kwargs`. |
| `mistral:ministral-14b-2512`, `mistral:ministral-8b-2512` | `response_format: json_object` | no se envía | `service_tier=standard_only` (Free / Standard). El mismo perfil aplica a otros IDs Mistral si se activan por override. |
| `zai:glm-4.7-flash`, `zai:glm-4.5-flash` | `response_format: json_object` | `thinking: { type: "disabled" }` | El thinking de GLM-4.7 está on por defecto y consume `max_tokens`. |
| `cloudflare:@cf/zai-org/glm-4.7-flash`, `cloudflare:@cf/google/gemma-4-26b-a4b-it` | no se envía `response_format` | `reasoning_effort: null` y `chat_template_kwargs.enable_thinking: false` | La allowlist oficial de JSON Mode de Workers AI no incluye estos IDs; el schema editorial externo sigue validando. |

`--ai-max-requests` limita los HTTP requests del pool completo, incluidos fallos, retries y fallbacks. `--ai-route provider:model` fija una sola route para diagnóstico.

El `report.json`, el resumen de consola y el Job Summary separan provider, modelo y `routeId`. Distinguen llamadas lógicas, requests HTTP, retries de la misma route, HTTP de fallback, llamadas con fallback, caché, deferred, rate limits, **concurrency-pressure**, cuotas agotadas y circuitos abiertos. Un 429 de Mistral sin headers extra aparece como rate-limit indeterminado, no como cuota agotada. Si llegan `x-ratelimit-remaining-req-minute` / `tokens-minute` / `tokens-month` (o `Retry-After`), el report indica request-frequency, TPM, monthly o reset. Un `1302` de Z.AI aparece como `concurrency-pressure`, no como rate-limit genérico ni como cuota diaria. Hay una tabla compacta por route (HTTP, válidas, rate limits, pressure, circuito). El detalle completo permanece en el artifact.

## Smoke tests manuales

Son llamadas **live** a las APIs de los proveedores: consumen quota real. No se ejecutan automáticamente en CI (ni en push ni en pull request), no escriben `data/**` y no crean PRs. Conviene lanzarlos tras cambiar providers, modelos, transports o prompts, o cuando una ingestión muestre comportamientos sospechosos.

Descubren las routes con la misma configuración que el pool de producción (`inspectFreePoolFromEnv`) y reutilizan directamente cada transport, payload, prompt, schema y parser real. El runner llama una sola vez a `route.transport.request()` por celda, con el timeout HTTP de producción (15 s): no usa `AiPoolClassifier`, retries, fallback, cache, scheduler, circuit breaker ni estado persistente. Un proveedor esperado sin key o sin confirmación gratuita no desaparece: cuenta como FAIL.

Por defecto prueba un solo purpose (`eligibility`, como máximo un HTTP por route). `--purpose taxonomy` cambia el fixture; `--all-purposes` recorre eligibility, composer extraction, access y taxonomy (como máximo un HTTP por `route × purpose`). Cada fixture declara una expectativa semántica mínima y no ambigua; no basta con devolver JSON compatible.

Los providers avanzan en paralelo. Dentro de cada provider hay como máximo dos workers —o menos si `providerMaxConcurrent` es más restrictivo—, cada route mantiene un único request en vuelo y los inicios respetan sus `rpm` / `minIntervalMs` y el `providerMinIntervalMs`. No hay retries ocultos. Un fallo funcional, output inválido, timeout o 429 transitorio no impide probar los demás purposes. Sólo auth, modelo inequívocamente inexistente/no disponible y cuota diaria explícitamente agotada bloquean los purposes restantes de esa route.

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
```

El comando carga `.local/ai.env`, fuerza `AI_ZERO_COST_ONLY=true` e imprime una línea JSON por celda (provider, model, route, purpose, estado, validez estructural/semántica, HTTP status, provider error code, latencia, tokens/rate-limit y mensaje sanitizado) más el informe completo. Los estados son:

- `PASS`: estructura y semántica esperadas;
- `SEMANTIC_FAIL`: schema válido, resultado equivocado;
- `SCHEMA_FAIL`: objeto parseable que incumple el schema;
- `INVALID_OUTPUT`: vacío, JSON malformado o respuesta incompleta;
- `RATE_LIMIT` / `DAILY_QUOTA`: límite transitorio o cuota diaria explícita;
- `TIMEOUT`, `AUTH`, `MODEL_UNAVAILABLE`, `REQUEST_ERROR` o `TRANSPORT_ERROR`: causa técnica concreta;
- `CONFIG_ERROR`: route/provider no configurado;
- `BLOCKED`: no hizo request porque un fallo global previo de esa route lo hacía inútil.

```text
AI LIVE SMOKE TEST — DIRECT ONE-SHOT

Route                                  Eligibility  Latency   Result
gemini:gemini-3.8-flash                PASS         1320 ms   PASS

Routes fully PASS: 16
Routes partially PASS: 1
Routes FAIL: 1
Missing/unconfigured providers: 0
HTTP requests performed: 18
Total duration: 42.3 s

RESULT: FAIL
```

En GitHub hay dos workflows manuales (`workflow_dispatch`, `contents: read`, mismos secrets/`vars` que la ingestión). No publican datos:

- **AI route smoke** — una route exacta (`provider:model`) y un purpose (o `all`).
- **AI live smoke test** — `npm run ai:smoke:all`, con el input `all_purposes`.

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
- Mistral: Free mode y primer request: <https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request>
- Mistral Chat Completions y JSON mode: <https://docs.mistral.ai/api>
- Mistral rate limits (RPS y TPM independientes; `X-RateLimit-Remaining`): <https://docs.mistral.ai/resources/known-limitations>
- Mistral `service_tier=standard_only`: <https://docs.mistral.ai/inference/priority-tier>
- Mistral 429 en Free mode: <https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them>
- Z.AI: thinking (default on en GLM-4.7; `thinking.type=disabled`): <https://docs.z.ai/guides/capabilities/thinking-mode>
- Z.AI: parámetros, incluido `thinking`: <https://docs.z.ai/guides/overview/concept-param>
- Z.AI: JSON mode / structured output: <https://docs.z.ai/guides/capabilities/struct-output>
- Z.AI: Chat Completions: <https://docs.z.ai/api-reference/llm/chat-completion>
- Z.AI: códigos de error (`1302` high concurrency / rate limit reached for requests; `1305` overload): <https://docs.z.ai/api-reference/api-code>
- Z.AI: GLM-4.7 (incluye Flash): <https://docs.z.ai/guides/llm/glm-4.7>
- Z.AI: GLM-4.5 / Flash y structured output: <https://docs.z.ai/guides/llm/glm-4.5>
- Z.AI: precios por modelo: <https://docs.z.ai/guides/overview/pricing>
- Z.AI: endpoint general: <https://docs.z.ai/guides/develop/http/introduction>
- Cloudflare: Free frente a Paid: <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- Cloudflare: endpoint OpenAI-compatible: <https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>
- Cloudflare: errores, incluido `3036`: <https://developers.cloudflare.com/workers-ai/platform/errors/>
- Cloudflare JSON Mode (allowlist de modelos): <https://developers.cloudflare.com/workers-ai/features/json-mode/>
- Cloudflare `@cf/zai-org/glm-4.7-flash` (`reasoning_effort`, `chat_template_kwargs`, `response_format`): <https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/>
- Cloudflare `@cf/google/gemma-4-26b-a4b-it`: <https://developers.cloudflare.com/ai/models/@cf/google/gemma-4-26b-a4b-it/>
