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
5. `mistral:mistral-small-latest`;
6. `zai:glm-4.7-flash` y `zai:glm-4.5-flash`;
7. `cloudflare:@cf/zai-org/glm-4.7-flash` y `cloudflare:@cf/google/gemma-4-26b-a4b-it`.

Cada lista puede reordenarse con `*_MODELS`. En zero-cost mode, Z.AI, Cloudflare y Gemini rechazan IDs fuera de su allowlist. Mistral no recibe cuotas públicas inventadas: aprende de `429`/`Retry-After`/`X-RateLimit-*` y admite overrides `MISTRAL_MODEL_RPM`, `MISTRAL_MODEL_TPM` y `MISTRAL_MODEL_RPD`. Groq empieza con los límites Free publicados y también admite overrides por modelo. Z.AI admite los mismos overrides; tampoco hay un default numérico inventado.

Esos `*_MODEL_RPM` / `*_MODEL_TPM` / `*_MODEL_RPD` son configuración no sensible. En producción el workflow las lee de `vars.*` (nunca de secrets). Si la variable de repositorio está vacía, se aplican los defaults de código descritos arriba. En local viven en `.local/ai.env`.

El scheduler también entiende límites genéricos de presión por route/provider: `maxConcurrent`, `minIntervalMs`, `providerMaxConcurrent` y `providerMinIntervalMs`. Se declaran en la route o con overrides `*_MODEL_MAX_CONCURRENT`, `*_MODEL_MIN_INTERVAL_MS`, `*_MAX_CONCURRENT` y `*_MIN_INTERVAL_MS`. El scheduler no hardcodea reglas por provider.

Durante una ejecución, una route que acumula varios fallos consecutivos relevantes (empty/incomplete/timeout/transport/output inválido) sin un resultado válido entre medias abre un circuit breaker in-memory. Rate limits, RPM/RPD y cuota diaria siguen sus mecanismos propios. El circuito no se persiste entre runs y nunca introduce un provider de pago.

## Perfiles HTTP por modelo

Las tareas del pool (eligibility, compositores, acceso, taxonomy) piden JSON corto. El transport OpenAI-compatible es único; cada route declara el payload que su proveedor admite:

| Route | JSON mode | Thinking / reasoning | Notas |
|---|---|---|---|
| `groq:*` | `response_format: json_object` | no se envía | No añadir `thinking` ni `chat_template_kwargs`. |
| `mistral:mistral-small-latest` | `response_format: json_object` | no se envía | `service_tier=standard_only` (Free / Standard). |
| `zai:glm-4.7-flash`, `zai:glm-4.5-flash` | `response_format: json_object` | `thinking: { type: "disabled" }` | El thinking de GLM-4.7 está on por defecto y consume `max_tokens`. |
| `cloudflare:@cf/zai-org/glm-4.7-flash`, `cloudflare:@cf/google/gemma-4-26b-a4b-it` | no se envía `response_format` | `reasoning_effort: null` y `chat_template_kwargs.enable_thinking: false` | La allowlist oficial de JSON Mode de Workers AI no incluye estos IDs; el schema editorial externo sigue validando. |

`--ai-max-requests` limita los HTTP requests del pool completo, incluidos fallos, retries y fallbacks. `--ai-route provider:model` fija una sola route para diagnóstico.

El `report.json`, el resumen de consola y el Job Summary separan provider, modelo y `routeId`. Distinguen llamadas lógicas, requests HTTP, retries de la misma route, HTTP de fallback, llamadas con fallback, caché, deferred, rate limits, cuotas agotadas y circuitos abiertos. Hay una tabla compacta por route (HTTP, válidas, rate limits, circuito). El detalle completo permanece en el artifact.

## Smoke tests manuales

No se ejecutan en CI y nunca escriben `data/**`:

```bash
npm run ai:smoke -- --route groq:openai/gpt-oss-120b
npm run ai:smoke -- --route mistral:mistral-small-latest
npm run ai:smoke -- --route zai:glm-4.7-flash
npm run ai:smoke -- --route cloudflare:@cf/zai-org/glm-4.7-flash
```

El comando carga `.local/ai.env`, fuerza una route, desactiva caché y prueba fixtures de eligibility, composer extraction, access y taxonomy. Imprime route, purpose, éxito, validez de schema, latencia, tokens y error/status sanitizado.

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
12. Ejecutar los smoke tests de cada route.
13. Lanzar un `workflow_dispatch` en `dry-run` antes del primer publish.

Las keys ausentes dejan fuera su provider sin romper la ingestión. Gemini sigue funcionando por sí solo.

## Fuentes oficiales verificadas

- Groq: modelos, límites Free y rate-limit headers: <https://console.groq.com/docs/rate-limits>
- Groq: compatibilidad OpenAI: <https://console.groq.com/docs/openai>
- Mistral: Free mode y primer request: <https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request>
- Mistral Chat Completions y JSON mode: <https://docs.mistral.ai/api>
- Mistral rate limits y `X-RateLimit-Remaining`: <https://docs.mistral.ai/resources/known-limitations>
- Mistral `service_tier=standard_only`: <https://docs.mistral.ai/inference/priority-tier>
- Mistral 429 en Free mode: <https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them>
- Z.AI: thinking (default on en GLM-4.7; `thinking.type=disabled`): <https://docs.z.ai/guides/capabilities/thinking-mode>
- Z.AI: parámetros, incluido `thinking`: <https://docs.z.ai/guides/overview/concept-param>
- Z.AI: JSON mode / structured output: <https://docs.z.ai/guides/capabilities/struct-output>
- Z.AI: Chat Completions: <https://docs.z.ai/api-reference/llm/chat-completion>
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
