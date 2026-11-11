# Validación de Fundación Juan March — fetch relay

> **Documentación histórica.** Snapshot de la validación del fetch relay contra Fundación Juan March (2026-08-31). **No** es el estado operativo actual ni un requisito de implementación.
>
> Lo implementado hoy está en [`docs/ingestion.md`](../ingestion.md). El Worker está en [`infra/fetch-relay`](../../infra/fetch-relay/README.md).
>
> Consérvese como evidencia de aquella corrida. Las métricas y runs de este fichero no deben copiarse a documentación vigente.

Base: `main` en `c8547d1` (PR #42). No se modifica `data/**`. Adapter, hydration, clasificación y reconciliation de #40/#41 permanecen intactos.

## Conclusión operativa

El bloqueo de egress de GitHub-hosted Actions hacia `www.march.es` está resuelto mediante el fetch relay. El transporte de producción es:

```text
GitHub Actions → Cloudflare Worker (fetch relay) → www.march.es
```

Evidencia definitiva: [run `33394617365`](https://github.com/gorfreee/clasica_madrid/actions/runs/33394617365) — `mode=dry-run`, `sources=fundacion-juan-march`, rama `feat/ingest-fetch-relay` (`592734d`), con `INGEST_FETCH_RELAY_URL` y `INGEST_FETCH_RELAY_TOKEN` configurados. Job: success. Listing + las 11 fichas actuales pasaron por el relay.

| Campo | Valor |
|---|---|
| Ventana | 2026-08-31 → 2026-12-29 |
| Sources attempted / succeeded / failed | 1 / 1 / 0 |
| RawEvents | 11 |
| Hydration attempted / succeeded / failed | 11 / 11 / 0 |
| Hydration skipped (fuera de ventana / circuit open) | 0 / 0 |
| Structural skips | 0 |
| include / exclude / uncertain | 11 / 0 / 0 |
| Candidates | 11 |
| new / updated / unchanged | 10 / 1 / 0 |
| ambiguous / duplicates / possiblyMissing | 0 / 0 / 0 |
| Disappearance suppression | ninguna |
| Health | `degraded` (`ai-deferred`, `unresolved-taxonomy`) |
| `autoMergeEligible` | true |
| `data/**` | intacto |

El `degraded` no es un problema del relay ni de adquisición. Listing, hydration y el resto del pipeline de March están sanos. Dos eventos quedaron sin `format` por IA/taxonomy diferida; ambos son `include` y candidatos válidos. No se corrige en esta PR.

`fundacion-juan-march` conserva `useFetchRelay: true` y ya no marca `skipDefaultSync`: forma parte de `sources=all` y de las ingestions programadas. Un relay ausente, incompleto o un 403/500 sigue siendo fallo visible, no un éxito vacío.

`getText` sigue siendo la abstracción común. March usa el relay porque el registry marca `useFetchRelay: true`, y sólo cuando `INGEST_FETCH_RELAY_URL` y `INGEST_FETCH_RELAY_TOKEN` están los dos. El adapter de March no conoce Cloudflare. Las URLs lógicas, citations, `externalId` y reports siguen siendo `https://www.march.es/...`.

Worker: [`infra/fetch-relay`](../../infra/fetch-relay/README.md). Genérico y autenticado (GET, Bearer, sólo HTTPS público, sin redirects cross-origin, cookie jar same-origin, HTML final sin `Set-Cookie`). No tiene allowlist de March; el único interruptor es `useFetchRelay` en el registry.

## Evidencia histórica (egress directo de Actions)

Antes del relay, GitHub-hosted Actions recibía HTTP 403 en el primer request a `https://www.march.es/es/madrid/conciertos`. Eso no dependía de Node fetch, curl, HTTP/1.1 vs HTTP/2, headers ni ubuntu vs macOS (PR #42). En redes que reciben el 307 de nginx, el cliente directo de `getText` reenvía el `Set-Cookie` y obtiene 200; Actions no llega a ese desafío.

| Run | Código | Listing | RawEvents | Hydration | Health | `data/**` |
|---|---|---|---|---|---|---|
| [`33378603348`](https://github.com/gorfreee/clasica_madrid/actions/runs/33378603348) | `main` #40 | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33380991290`](https://github.com/gorfreee/clasica_madrid/actions/runs/33380991290) | rama #41, cookie jar | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33381711259`](https://github.com/gorfreee/clasica_madrid/actions/runs/33381711259) | `main` #41 | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33383332172`](https://github.com/gorfreee/clasica_madrid/actions/runs/33383332172) | matriz HTTP #42 | 403 en todos los clientes | — | — | — | intacto |
| [`33389595159`](https://github.com/gorfreee/clasica_madrid/actions/runs/33389595159) | esta rama, relay aún sin configurar | HTTP 403 directo | 0 | 0 | `fatal` | intacto |

Cloudflare Workers sí alcanzaban March (listing 307 + `Set-Cookie` → replay same-origin → 200; fichas 200). El 403 de Actions era un bloqueo de egress, no un bug del parser.

No se reabre la vía de User-Agent, retries, Playwright ni endpoints alternativos de March. El probe HTTP directo (`March HTTP diagnostic`) se retiró: el transporte de producción es el fetch relay.
