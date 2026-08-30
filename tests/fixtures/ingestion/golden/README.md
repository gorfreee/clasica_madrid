# Golden evaluation set

Dataset de evaluación para la Classification Policy. Las reglas deterministas deben ser generales: **no es una tabla de lookup**. Los tests inyectan un fake de IA; CI no llama a un LLM.

Política: [`docs/classification-policy.md`](../../../docs/classification-policy.md).

## Forma de cada caso

```text
listingTitle     → lo que vería el harvest de listado
observed         → hechos de la ficha oficial (no inventados)
expected         → eligibility / formats / eras / kind / access
reason           → por qué
missingEvidence  → obligatorio si eligibility=uncertain
```

`eligibility` es metadata interna. No es un campo del schema canónico `Event`.

Sólo `include` es publicable automáticamente. Si `expected.eligibility === include`, `kind` debe estar resuelto (`established` o `alternative`). `kind` puede omitirse en `exclude`/`uncertain`.

Los casos cubren diversidad de fuentes, formatos e inclusiones/exclusiones. El conteo exacto es el de los JSON de este directorio.

## Cómo se obtuvieron los hechos

Consulta de las URLs oficiales. Se copió lo que la ficha declara. No se usó conocimiento general para rellenar obras ausentes. HTML completo no se guarda aquí: el golden set es la capa de *observed facts*. Fixtures HTML de parser viven en `../detail/`.

## Datos deliberadamente unknown / vacíos

- `access=unknown` cuando no hay precio ni «gratuito»/«entrada libre» en `accessText`.
- `eras=[]` cuando no hay obras ni compositores observables.
- `kind` omitido si eligibility no es `include`.
- Para `include` sin evidencia established, `kind=alternative`.

Un título de listado puede sugerir lo contrario de la ficha (gala de Navidad popular, código interno que es Mahler, «flamencos» que son franco-flamencos). La ficha manda; cada caso documenta el `reason`.

## Qué no hace este dataset

- No publica el catálogo.
- No llama a un LLM.
- No es un lookup `caseId → resultado`.
