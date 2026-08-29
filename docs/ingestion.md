# Ingestión de eventos

Este documento es la **puerta de entrada operativa** a la ingestión: qué hay implementado hoy y hacia dónde ir.

No es la especificación de arquitectura objetivo.

| Qué necesitas | Dónde |
|---|---|
| Diseño objetivo vigente (fuente de verdad para evolucionar la ingestión) | [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md) |
| Estado operativo actual (este documento) | `docs/ingestion.md` |
| Modelo de datos canónico | [`docs/data-model.md`](data-model.md) |
| Investigación y planes anteriores (histórico, no requisitos) | [`docs/archive/`](archive/) |

La web no escribe datos. Todo lo publicado entra por Git, pasa validación determinista y CI, y entonces se fusiona.

## Estado actualmente implementado

Hoy la ingestión es un flujo **manual de candidatos JSON**, anterior a la v3.

1. Un agente o una persona extrae un evento y lo escribe como candidato (`src/lib/schemas/candidate.ts`).
2. El fichero se deja en `ingestion/inbox/` (gitignored).
3. `npm run ingest:promote` valida, fusiona en memoria con `data/` y, si todo es correcto, escribe ficheros nuevos.

```bash
npm run ingest:promote -- ingestion/inbox/mi-evento.json
```

El script no sobrescribe un evento que ya exista. Si el candidato incluye un lugar, organizador, serie o fuente cuyo ID ya está en el catálogo, la entidad candidata debe coincidir campo a campo con la canónica. Cualquier diferencia es un conflicto: la promoción falla y no escribe ningún fichero.

Los duplicados de alta confianza (mismo lugar + fecha + hora + título normalizado) se rechazan. La misma URL de fuente + la misma fecha no bloquea: si aparece, es sólo un aviso. Los casos ambiguos quedan para revisión.

Al extraer, una misma entidad `Event` solo agrupa `occurrences` cuando comparten los atributos musicales y contextuales esenciales. Si cambian de forma sustancial el lugar, el programa, el reparto relevante o las condiciones, son eventos separados.

Directorios de trabajo (ignorados por Git):

- `ingestion/inbox/` — candidatos pendientes
- `ingestion/work/` — normalización en curso
- `ingestion/rejected/` — descartados, para inspección

Formato mínimo de un candidato:

```json
{
  "schemaVersion": 1,
  "event": { "...": "mismo esquema que data/events" },
  "venue": { "...": "opcional, si el lugar es nuevo" },
  "organizers": [],
  "series": null,
  "sources": [],
  "notes": "opcional, no se publica"
}
```

Un agente de IA puede descubrir, extraer y clasificar. Nunca debe saltarse la validación ni escribir directo en `data/` de producción sin el mismo esquema que un cambio manual.

## Infraestructura legacy durante la migración

Mientras se implementa la v3, puede seguir existiendo esta infraestructura:

- `ingest:promote`
- `ingestion/inbox/`
- `ingestion/work/`
- `ingestion/rejected/`
- el esquema `Candidate` como fichero JSON en disco

Eso es el **estado actual**, no el diseño futuro. No lo interpretes automáticamente como arquitectura objetivo ni lo tomes como requisito para nuevas piezas de ingestión.

La v3 prevé que, en el flujo automático normal, los candidatos puedan existir sólo en memoria; `ingestion/inbox/` queda como herramienta de imports manuales, debugging y casos excepcionales. Ver [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md).

## Arquitectura objetivo

La fuente de verdad para cualquier trabajo de evolución de la ingestión es [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md).

Principio rector de la v3: *el código obtiene y controla los hechos; la IA ayuda a interpretar, enriquecer, descubrir y reparar; Git valida y publica.*

El flujo normal previsto (harvesting con adapters, `RawEvent`, normalización, enrichment, reconciliación, PR y auto-merge, cadencia ~10 días, ventana de 120 días) está especificado allí. No se duplica en este documento.

Hoy **no** están implementados adapters, `RawEvent`, discovery automático, enrichment, reconciliación ni el workflow programado en GitHub Actions. No los añadas salvo que una tarea pida explícitamente implementar una fase de la v3.

## CI y auto-merge (hoy vs objetivo)

La CI actual (`.github/workflows/ci.yml`) valida, testea, typecheckea y construye. **No** aprueba PRs ni fusiona sola.

El objetivo de la v3 es que una ejecución sana llegue a merge sin intervención humana ordinaria, con auto-merge sólo si los checks están verdes. Eso requiere configuración de GitHub que no vive en el código y **no** forma parte de la implementación actual. No añadas branch protection, required checks ni workflows de ingestión a menos que una tarea lo pida.

## Documentación histórica

No usar como especificación vigente, salvo que una tarea pida investigar decisiones anteriores:

- [`docs/archive/ingestion-v2-plan.md`](archive/ingestion-v2-plan.md) — plan de evolución v2
- [`docs/archive/ingestion-inspiration.md`](archive/ingestion-inspiration.md) — investigación de patrones externos
