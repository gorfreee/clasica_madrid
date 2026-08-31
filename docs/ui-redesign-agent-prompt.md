# Prompt — implementar el rediseño de interfaz

Implementa el rediseño visual completo de la interfaz pública de Clásica Madrid y abre una PR.

Antes de modificar nada:

- lee `AGENTS.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md` y, sobre todo, `docs/ui-redesign.md`;
- inspecciona la UI actual, `src/lib/presentation`, los tests y los contratos que conectan presentación e interacción;
- recorre el catálogo real para entender la variedad y los casos difíciles de contenido.

`docs/ui-redesign.md` es la fuente de verdad para producto, UX, alcance, dirección visual y restricciones de esta tarea. Las decisiones principales ya están convergidas: no hace falta volver a plantear el producto ni crear varias propuestas separadas antes de implementar.

Quiero una implementación fuerte y coherente de toda la experiencia pública —agenda/home, navegación, búsqueda y filtros, fichas de evento, lugares y estados secundarios—, no un simple restyling de los componentes actuales. Usa criterio de diseño para resolver tipografía, paleta, grid, responsive, composición, controles y detalles de interacción dentro de la libertad que deja el documento. Itera si la primera solución resulta genérica o funciona mal con datos reales.

Mantén la arquitectura static-first y los contratos existentes salvo que el nuevo UX necesite evolucionarlos de forma deliberada. No cambies ingestión ni `data/**` para resolver problemas puramente visuales.

Prueba la solución en móvil y desktop con eventos reales y casos extremos. Ejecuta las validaciones relevantes del repositorio (`validate`, `test`, `check`, `build` y `test:e2e`) y adapta o añade tests cuando cambie comportamiento cubierto.

La PR debe quedar lista para revisar visual y funcionalmente. En su descripción resume la dirección implementada, cualquier decisión relevante tomada durante el diseño, cambios de comportamiento o contratos, y la validación realizada.