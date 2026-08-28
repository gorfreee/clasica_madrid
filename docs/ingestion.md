# Ingestión de eventos

La web no escribe datos. Todo lo publicado entra por Git, pasa validación determinista y CI, y entonces se fusiona.

```text
discovery
   ↓
candidate data          ingestion/inbox/   (gitignored)
   ↓
normalization
   ↓
deterministic validation
   ↓
duplicate checks
   ↓
PR
   ↓
CI                      .github/workflows/ci.yml
   ↓
merge
```

Un agente de IA puede descubrir, extraer y clasificar. Nunca debe saltarse la validación ni escribir directo en `data/` de producción sin el mismo esquema que un cambio manual.

## Candidatos

Formato: `src/lib/schemas/candidate.ts`.

Un candidato incluye el evento y, si aún no existen, el lugar / organizadores / serie / fuentes a crear. Ejemplo mínimo:

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

Directorios de trabajo (ignorados por Git):

- `ingestion/inbox/` — candidatos pendientes
- `ingestion/work/` — normalización en curso
- `ingestion/rejected/` — descartados, para inspección

Promoción a datos canónicos:

```bash
npm run ingest:promote -- ingestion/inbox/mi-evento.json
```

El script valida el candidato, lo fusiona en memoria con `data/`, aplica las mismas reglas de referencias y duplicados, y sólo entonces escribe ficheros nuevos. No sobrescribe un evento que ya exista. Si el candidato incluye un lugar, organizador, serie o fuente cuyo ID ya está en el catálogo, la entidad candidata debe coincidir campo a campo con la canónica (incluidos los opcionales ausentes o presentes). Cualquier diferencia es un conflicto explícito: la promoción falla y no escribe ningún fichero. Nunca reutiliza en silencio un ID existente con datos distintos, ni pisa una entidad canónica.

Los duplicados de alta confianza (mismo lugar + fecha + hora + título normalizado) se rechazan. La misma URL de fuente + la misma fecha no bloquea la validación ni la promoción: si aparece, es sólo un aviso informativo. Los casos ambiguos quedan para revisión humana.

Al extraer, una misma entidad `Event` solo agrupa `occurrences` cuando comparten los atributos musicales y contextuales esenciales. Si cambian de forma sustancial el lugar, el programa, el reparto relevante o las condiciones, son eventos separados.

## Descubrimiento futuro

La búsqueda periódica combinará, sin acoplar la web a un proveedor de IA:

- fuentes institucionales conocidas
- festivales y ciclos
- auditorios y teatros
- iglesias
- conservatorios y universidades
- asociaciones
- búsquedas abiertas para lo difícil de encontrar

Preferir mecanismos deterministas (ICS, JSON, HTML estable) cuando existan. Reservar la IA para extracción ambigua, clasificación y deduplicación tentativa.

## Auto-merge

La CI de este repositorio **no** aprueba PRs. Para que actualizaciones de datos de alta confianza puedan auto-fusionarse hace falta configuración de GitHub que no vive en el código:

1. Activar auto-merge en el repositorio.
2. Branch protection / ruleset en `main` que exija el check `CI / verify`.
3. (Opcional, más adelante) limitar el auto-merge a PRs que sólo toquen `data/**` y procedan de un actor de confianza.

No añadir bots que aprueben reviews automáticamente. Los cambios ambiguos, fuentes nuevas o fallos de duplicados deben seguir revisándose a mano.
