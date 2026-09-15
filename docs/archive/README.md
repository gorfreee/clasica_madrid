# Archivo histórico

Los documentos de esta carpeta conservan decisiones, investigaciones, planes, briefs y validaciones **históricas**.

Pueden describir arquitecturas, flujos, interfaces o comportamientos que **ya no existen**. No son requisitos ni instrucciones vigentes. No deben usarse para implementar cambios actuales salvo que una tarea pida expresamente investigar decisiones históricas.

## Jerarquía de autoridad ante contradicciones

Cuando un documento de archivo discrepe de material vigente, interpreta así la precedencia. El objetivo no es que «el código siempre gane» sobre una decisión de producto, sino evitar que un plan o brief antiguo se lea como requisito actual.

1. **Contratos ejecutables y código actual** cuando describen el comportamiento implementado (schemas, tests, workflows, registry, configuración).
2. **`AGENTS.md`** para instrucciones de trabajo de agentes.
3. **Documentos activos específicos** del tema: [`docs/ingestion.md`](../ingestion.md), [`docs/data-model.md`](../data-model.md), [`docs/classification-policy.md`](../classification-policy.md) y equivalentes.
4. **Arquitectura y roadmap** para principios estables y dirección: [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`docs/ingestion-v3-plan.md`](../ingestion-v3-plan.md), [`PROJECT_CONTEXT.md`](../../PROJECT_CONTEXT.md).
5. **`docs/archive/`** únicamente como contexto histórico.

Si una tarea pide recuperar una decisión antigua, cita el documento de archivo como evidencia de aquel momento y contrástala con el código y los documentos activos actuales antes de proponer un cambio.
