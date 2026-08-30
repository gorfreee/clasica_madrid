# Hardening de Zarzuela — validación

## Evidencia y causa

Base inspeccionada: `main` en `ad629c644ce8bd60a28792c85a5d7e3cd9baa1df`,
incluida la [PR original #36](https://github.com/gorfreee/clasica_madrid/pull/36).
Se revisaron logs y los cuatro ficheros del artifact `9739292202` de la
[run 33336857648](https://github.com/gorfreee/clasica_madrid/actions/runs/33336857648).

El listing descubrió 40 obras. Las 40 fichas se intentaron secuencialmente sin
pausas ni retries en una ingestión de unos 22 segundos; 39 devolvieron HTTP 403.
La única ficha correcta era de febrero de 2027, fuera de ventana. Las 40
observaciones quedaron en structural skip; ninguna llegó a clasificación.
El pipeline consideraba suficiente un listing correcto para marcar la source
como succeeded; cualquier número de fallos de hydration sólo añadía degraded.
Disappearance usaba ese succeeded y tres eventos publicados quedaron como
possiblyMissing aunque faltaba evidencia para evaluarlos.

El 403 es un rechazo HTTP observado. No se ha demostrado si su causa concreta
es el ritmo, la IP de Actions o alguna otra política del servidor. No se intenta
eludir la protección ni se afirma haber eliminado los bloqueos de Actions.

## Política implementada

- Prefiltro sobre el texto temporal completo del listing: fechas explícitas y
  rangos simples con año observado. Sólo se omite la ficha cuando todos sus
  límites quedan fuera de la ventana inclusiva. Año ausente, fechas imposibles,
  día de semana contradictorio, listas compuestas y otros textos no reconocidos
  siguen a hydration. Dos listings contradictorios de una URL invalidan el hint.
- Sólo las fichas de Zarzuela esperan al menos 1,5 segundos entre requests,
  desde el final de la anterior. Máximo dos requests por ficha: un retry para
  403/408/429/500/502/503/504, espera de 2 segundos más jitter de 0–499 ms.
  No hay retries de errores de parsing ni de 404.
- Retry-After admite segundos y fecha HTTP; también retrasa la siguiente ficha
  cuando ya no quedan retries. Si exige más de 60 segundos, se abandona la
  hydration restante de la ejecución, sin acortar la espera del servidor.
- Tres respuestas consecutivas del mismo tipo (403 o 429), incluidos retries,
  abren circuito. Un éxito HTTP o un error de otro tipo reinician la secuencia.
  El circuito no persiste entre ejecuciones. No cambia el User-Agent.
- Las fichas omitidas por ventana y por circuito tienen motivos distintos y
  no cuentan como intentadas. Report y journal conservan intentos por ficha,
  códigos de error HTTP y esperas de retry. El resumen cuenta cada tipo de omisión.
- Se excluyen del denominador las fichas demostrablemente fuera de ventana.
  La cobertura es severa si no se pudo hidratar ninguna ficha necesaria, o si
  al menos tres fichas necesarias no están disponibles y representan al menos
  la mitad. Se conserva el mecanismo de source failure con `stage: hydration`:
  health fatal si no queda ninguna source sana, review si otras sí lo están;
  ambos impiden auto-merge. Fallos aislados permanecen degraded.
- Cualquier ficha necesaria no disponible suprime possiblyMissing de Zarzuela,
  incluso por debajo del umbral severo. Se explicita en
  `disappearanceSuppressedSources`. En un snapshot sano, una URL vista en el
  listing es evidencia de presencia aunque la ficha se haya omitido por ventana;
  esto no cambia las fechas publicadas. Ausencias reales de sources sanas
  conservan la detección habitual.

## Decisión sobre fechas de respaldo

`RawOccurrence` admite fecha sin hora y normalización produce `time: null`.
Eso no basta para un fallback seguro en este adapter: el listing no establece
la sede; además, un error de ficha puede significar sedes múltiples o una
contradicción temporal. Los updates de eventos existentes pueden reconciliar
fechas por URL sin la puerta de publicación de eventos nuevos.

Por ello no se introducen occurrences del listing ni una nueva puerta especial
de publicación: `Martes, 29 de septiembre de 2026` se conserva literalmente
como evidencia y se usa para el prefiltro; un rango nunca se expande. Una ficha
fallida sigue sin calendario publicable. No se inventan horas ni sedes, no se
añade el 26/9 omitido por La verbena y reconciliation conserva el ya publicado.
La interpretación musical permanece en el pipeline común.

## Prueba real

Dry-run en Linux con Node 24.19.0, sin credenciales de Gemini. Mismo entrypoint
de producción y ventana default del reloj del entorno, pero **no es un runner
de GitHub Actions ni una comparación controlada del efecto sobre sus 403**.

El wrapper `tsx` de npm no puede abrir su socket IPC en este entorno; se ejecutó:

```bash
node --import tsx src/cli/ingest.ts sync --dry-run --sources teatro-zarzuela \
  --report ingestion/reports/zarzuela-hardening/report.json \
  --observability-dir ingestion/reports/zarzuela-hardening
```

| Métrica | Actions 33336857648 | Dry-run local real con hardening |
|---|---:|---:|
| Ventana | 2026-08-30 → 2026-12-28 | 2026-08-31 → 2026-12-29 |
| RawEvents | 40 | 40 |
| Fichas necesarias / intentadas | 40 / 40 | 18 / 18 |
| Omitidas por ventana / circuito | 0 / 0 | 22 / 0 |
| Hydration correcta / fallida | 1 / 39 | 13 / 5 |
| Respuestas HTTP 403 | 39 | 0 |
| Include / exclude / uncertain | 0 / 0 / 0 | 1 / 3 / 8 |
| IA | 0 | 0 (no disponible) |
| Structural skips | 40 | 28 |
| Candidates (updates / nuevos) | 0 | 2 / 0 |
| PossiblyMissing | 3 | 0 (evaluación suprimida) |
| Health / autoMergeEligible | degraded / true | degraded / true |
| Cambios en data/** | 0 | 0 |

Las 18 fichas se descargaron sin errores HTTP, pero cinco no admiten calendario
seguro: tres por sedes externas/múltiples, una por secciones ausentes y una por
fecha incompatible con el día de semana. Se mantienen estos rechazos del
adapter original. De los otros 23 structural skips, 22 son el prefiltro y uno
es una ficha hidratada que finalmente cae fuera de ventana. Se verificó también
que los textos del artifact original producen el mismo prefiltro: 22/40.

El caso local sigue degraded/eligible porque 13/18 fichas son utilizables; los
cinco fallos no alcanzan el umbral severo. En cambio, los tests de bloqueo masivo
obtienen sólo tres requests HTTP, dos fichas intentadas y el resto diagnosticadas
como circuito abierto, con health fatal, autoMergeEligible false y cero missing.

## Validación posterior en Actions

El workflow hace checkout explícito de `main`, incluso si se despacha desde
otra rama. No se modifica ese control ni se usa un rerun del commit antiguo.
Después de mergear esta PR, lanzar **Production ingestion → Run workflow**:

| Input | Valor |
|---|---|
| Branch | main |
| mode | dry-run |
| sources | teatro-zarzuela |
| from / to | vacíos (ventana default actual) |
| auto_merge | false |
| ai_max_requests | vacío (comportamiento habitual) |

Revisar Job Summary y artifact: fichas intentadas/correctas/fallidas,
omisiones por ventana/circuito, códigos HTTP e intentos, decisiones editoriales,
structural skips, health y desapariciones suprimidas. Si vuelve el bloqueo
masivo, lo correcto es detener las peticiones, marcar source failure de hydration
y no permitir auto-merge; no obtener candidatos a cualquier coste.

## Validaciones y límites

Tests offline de fechas, transporte, circuito, cobertura, health, desapariciones,
reconciliation y journal; suite completa, Astro check, validación del catálogo
y build. `npm run validate` tiene el mismo límite de IPC de tsx; se verifica su
entrypoint con `node --import tsx src/cli/validate-data.ts`. `data/**` intacto.

Sin DB, infraestructura, browsers, proxies, evasión ni excepciones por título.
La pausa y el circuito reducen la carga y limitan daños; no garantizan acceso
desde una IP bloqueada. El parser temporal deliberadamente no reconoce todos
los textos: algunas fichas futuras ambiguas todavía se solicitan. La supresión
de desapariciones de toda la source prioriza precisión a costa de ocultar una
desaparición real hasta una ejecución completamente evaluable.
