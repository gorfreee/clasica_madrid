# Ingestión de eventos

Puerta de entrada operativa: qué hay implementado y cómo ejecutarlo.

| Qué necesitas | Dónde |
|---|---|
| Diseño objetivo (hacia dónde evolucionar) | [`docs/ingestion-v3-plan.md`](ingestion-v3-plan.md) |
| Política editorial de clasificación | [`docs/classification-policy.md`](classification-policy.md) |
| Modelo de datos canónico | [`docs/data-model.md`](data-model.md) |
| Código del pipeline | `src/ingestion/` |
| Registry de fuentes | `src/ingestion/registry.ts` |
| Prompt del fallback de IA | `src/ingestion/classification/ai-prompt.ts` |
| Golden evaluation set | `tests/fixtures/ingestion/golden/` |
| Variables de entorno de IA | `.env.example` |
| Histórico (no es requisito vigente) | [`docs/archive/`](archive/) |

La web no escribe datos. Todo lo publicado entra por Git, pasa validación determinista y CI, y entonces se fusiona.

## Qué hay implementado

Harvesting de fuentes conocidas (fases 1 y 2 del plan v3): extraer, hidratar fichas cuando el adapter lo soporta, normalizar, clasificar y, si el resultado es `include`, escribir **sólo eventos nuevos**.

```text
registry → extract → hydrate → normalize → classify → publication gate → validate → write
```

- Un fallo de listing aísla esa fuente; el resto continúa.
- Un fallo de ficha de detalle es local al evento: se conservan los hechos del listing.
- Clasificación: reglas deterministas y knowledge, con fallback de IA **sólo** si el determinista deja `uncertain`. Un `include` o `exclude` determinista no se reabre.
- Publicación: sólo `include` se convierte en Candidate. `exclude` y `uncertain` no se publican, no consumen IDs/slugs y no se mezclan con los descartes estructurales.
- `kind`, `formats`, `eras` y `access` salen del classifier, no de la source.
- `eras` / `formats` vacíos no bloquean un `include`.
- Escritura atómica de archivos **nuevos**. No actualiza ni borra eventos ya publicados.
- Una segunda ejecución contra los mismos inputs no debe escribir cambios canónicos.

No están implementados (no los añadas salvo que una tarea pida esa fase): discovery automático, reconciliación fuzzy, updates de eventos existentes, política de desapariciones, GitHub Actions de ingestión ni auto-merge.

Las fuentes concretas, adapters, flags de CLI y detalles de matching viven en el código. No los dupliques aquí.

## Cómo ejecutarlo

```bash
npm run ingest:sync
npm run ingest:sync -- --dry-run
npm run ingest:sync -- --dry-run --report ingestion/reports/sync.json
npm run ingest:source -- auditorio-nacional
```

`--dry-run` valida y resume sin escribir el catálogo. `--data-dir` apunta a otro árbol (por defecto `data/` o `DATA_DIR`). `--report` escribe un JSON diagnóstico por evento; no cambia la clasificación ni qué se publica. `ingestion/reports/` está gitignorado.

CI no llama a un LLM. Tests inyectan fakes.

## IA

El fallback es opcional y provider-agnóstico. La CLI crea como máximo un classifier por ejecución (`createAiClassifierFromEnv()`). Sin credenciales, timeout o respuesta inválida, el caso permanece `uncertain` y el lote continúa.

`ingest:sync` / `ingest:source` cargan `.local/ai.env` (gitignorado) si existe; el entorno del proceso gana. Plantilla y variables: `.env.example`. No commits ni imprimas la clave.

El estado local (caché, cuota, pendientes, lock) vive bajo `.local/ai/` por defecto, fuera de Git y de `data/`. `--dry-run` no escribe el catálogo, pero sí puede gastar cuota y guardar ese estado. No hay rotación de claves ni coordinación entre máquinas: Google limita por proyecto y modelo.

Flags `--ai-*` (modelo, sin caché, tope de requests) existen para pruebas acotadas. Requieren Gemini. Los tests ordinarios no las necesitan.

## Candidatos JSON (legacy)

Camino manual durante la migración, no la arquitectura objetivo:

```bash
npm run ingest:promote -- ingestion/inbox/evento.json
```

El candidato usa el esquema de `src/lib/schemas/candidate.ts`. El script valida, fusiona en memoria con `data/` y, si todo es correcto, escribe ficheros nuevos. No sobrescribe un evento existente. Si el candidato trae una entidad cuyo ID ya está en el catálogo, debe coincidir campo a campo.

Directorios de trabajo gitignorados: `ingestion/inbox/`, `ingestion/work/`, `ingestion/rejected/`, `ingestion/reports/`.

En el diseño v3 los candidatos del flujo automático existen en memoria. `ingestion/inbox/` queda para imports manuales, debugging y casos excepcionales.

Un agente puede descubrir, extraer y clasificar. Nunca debe saltarse la validación ni escribir directo en `data/` de producción.

## CI

La CI actual (`.github/workflows/ci.yml`) valida, testea, typecheckea y construye. No aprueba PRs ni fusiona sola. Branch protection, required checks y workflows de ingestión forman parte del *objetivo* v3, no de la implementación actual.
