# Validación de Fundación Juan March — fetch relay

Base: `main` en `c8547d1` (PR #42). No se modifica `data/**`. Adapter, hydration, clasificación y reconciliation de #40/#41 permanecen intactos.

## Conclusión operativa

GitHub-hosted Actions recibe HTTP 403 en el primer request a `https://www.march.es/es/madrid/conciertos`. Eso no depende de Node fetch, curl, HTTP/1.1 vs HTTP/2, headers ni ubuntu vs macOS (PR #42).

Cloudflare Workers sí alcanzan March: listing 307 + `Set-Cookie` → replay same-origin → 200; las fichas responden 200 con canonical, JSON-LD y `p-acto__fechas`.

El transporte de producción para este host es por tanto:

```text
GitHub Actions → Cloudflare Worker (fetch relay) → www.march.es
```

`getText` sigue siendo la abstracción común. Sólo `www.march.es` usa el relay, y sólo cuando `INGEST_FETCH_RELAY_URL` y `INGEST_FETCH_RELAY_TOKEN` están los dos. El adapter de March no conoce Cloudflare. Las URLs lógicas, citations, `externalId` y reports siguen siendo `https://www.march.es/...`.

Worker: [`infra/fetch-relay`](../infra/fetch-relay/README.md). Allowlist estricta (GET, Bearer, listing + `/es/madrid/concierto/*`, sin redirects cross-origin, cookie jar same-origin, HTML final sin `Set-Cookie`).

## `skipDefaultSync`

Permanece hasta que un dry-run real de `fundacion-juan-march` desde GitHub Actions **con el relay** resulte sano (listing 200, hydration de las fichas actuales, sin problemas nuevos de adquisición). `--sources fundacion-juan-march` sigue ejecutándola; un relay ausente, incompleto o un 403/500 sigue siendo fallo visible, no un éxito vacío.

## Dry-run desde GitHub Actions (esta PR)

[Run `33389595159`](https://github.com/gorfreee/clasica_madrid/actions/runs/33389595159) — `mode=dry-run`, `sources=fundacion-juan-march`, rama `feat/ingest-fetch-relay` (`6a1ce14`).

Los secrets `INGEST_FETCH_RELAY_URL` y `INGEST_FETCH_RELAY_TOKEN` estaban vacíos, así que `getText` usó el transporte directo (comportamiento correcto cuando el relay no está configurado). Resultado:

| Campo | Valor |
|---|---|
| Listing | HTTP 403 al pedir `https://www.march.es/es/madrid/conciertos` |
| RawEvents | 0 |
| Hydration attempted/succeeded/failed | 0 / 0 / 0 |
| Structural skips | 0 |
| include / exclude / uncertain | 0 / 0 / 0 |
| IA | 0 llamadas |
| Candidates | 0 |
| new / updated / unchanged | 0 / 0 / 0 |
| duplicates / ambiguous / possiblyMissing | 0 / 0 / 0 |
| Health | `fatal` (`no-sources-succeeded`, `source-failed:fundacion-juan-march`) |
| `data/**` | intacto (dry-run; el job falló antes del boundary check) |

El fallo es visible y conservador: no se convirtió en un éxito vacío. Falta desplegar el Worker (`infra/fetch-relay`) y configurar los dos secrets para repetir este dry-run con el relay.

## Evidencia previa (egress directo de Actions)

| Run | Código | Listing | RawEvents | Hydration | Health | `data/**` |
|---|---|---|---|---|---|---|
| [`33378603348`](https://github.com/gorfreee/clasica_madrid/actions/runs/33378603348) | `main` #40 | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33380991290`](https://github.com/gorfreee/clasica_madrid/actions/runs/33380991290) | rama #41, cookie jar | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33381711259`](https://github.com/gorfreee/clasica_madrid/actions/runs/33381711259) | `main` #41 | HTTP 403 | 0 | 0 | `fatal` | intacto |
| [`33383332172`](https://github.com/gorfreee/clasica_madrid/actions/runs/33383332172) | matriz HTTP #42 | 403 en todos los clientes | — | — | — | intacto |

En redes que reciben el 307 de nginx, el cliente directo de `getText` reenvía el `Set-Cookie` y obtiene 200. Actions no llega a ese desafío.

No se reabre la vía de User-Agent, retries, Playwright ni endpoints alternativos de March.

Para repetir la matriz **sin relay**: **Actions → March HTTP diagnostic**. No comparte el group `ingestion-production`.
