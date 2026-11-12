# CDCM: fuentes oficiales actuales, 12/11/2026

Las antiguas webs WordPress de Teatros del Canal y Teatro Auditorio de El Escorial
redirigen al portal oficial del Centro Dramático, Coreográfico y Musical de la
Comunidad de Madrid. Se capturaron las páginas públicas de `www.cdcm.madrid`, no
se descargó contenido del hostname `origin202603-cdcm.cdcm.madrid` que aparece en
sus metadatos. El parser sólo admite ese hostname como el alias exacto observado
en canonical/schema de la misma ruta; todas las peticiones y citas usan el dominio público.

## Capturas

- `canal-list.html`: `/teatroscanal/programacion/categoria/musica`, 12 fichas.
- `escorial-list.html`: `/auditorioescorial/programacion`, una ficha.
- `navidad.html`: `/auditorioescorial/espectaculo/concierto-navidad-2026`.
- Las otras fichas: `/teatroscanal/espectaculo/<nombre-del-fixture>`.
- `captures.json`: SHA-256 de las respuestas locales completas antes de reducirlas.

Los HTML son extractos estructurales: conservan canonical, JSON-LD, configuración
Views y contenido de `main`, incluidos calendario, programa, reparto, sala y
recomendaciones ajenas a la ficha. Se omiten imágenes/SVG y líneas vacías; se
eliminan espacios al final de línea. No se modifican hechos ni se inventan eventos.
Los tests de paginación reparten las tarjetas reales en páginas sintéticas;
las mutaciones de error son explícitas y no se atribuyen a la web.

`music-ajax-page1.json` conserva el comando real `insert/replaceWith` recibido de
`GET /views/ajax`, con la identidad y argumentos Views anunciados por el propio
listado de música. Se omiten los comandos de assets/settings, y se reducen las
imágenes/SVG del HTML como arriba. No hay página musical adicional actualmente:
solicitar `page=1` devuelve esas mismas 12 tarjetas. En la programación general,
que sí anuncia «Mostrar más», se comprobó el comando `infiniteScrollInsertView`
con una vista acumulativa de 24 tarjetas y enlace a `page=2`. El parser admite
ambos contratos y exige crecimiento y continuidad exacta antes de aceptar otra página.
Las URLs HTML con `?page=1` repiten la página cero; no se utilizan como prueba de cobertura.

## Evidencia desde GitHub Actions

1. [Run 43243315524](https://github.com/gorfreee/clasica_madrid/actions/runs/43243315524):
   Node fetch y Chrome reciben 403, curl descarga las dos agendas y dos fichas con 200.
2. [Run 43243606763](https://github.com/gorfreee/clasica_madrid/actions/runs/43243606763),
   [artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43243606763/artifacts/13955557599):
   prueba controlada HTTP/1.1 y HTTP/2, con UA por defecto de curl y UA de ingestión.
   `transport-responses.json` conserva los resultados reales con URLs, status,
   content-type, tamaño y SHA-256. Con UA nativo de curl funcionan ambos protocolos;
   con el identificador de ingestión ambos reciben 403. No es un requisito de HTTP/2.
3. [Dry-run real 43246192793](https://github.com/gorfreee/clasica_madrid/actions/runs/43246192793),
   [artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43246192793/artifacts/13956877022):
   CLI y adapters reales de la rama, curl registrado, catálogo de main y sin IA.
   12 fichas Canal + una Escorial, 15 observaciones tras separar el ciclo;
   15 hidrataciones correctas, cero fallidas, cero altas nuevas/duplicados, 11
   actualizaciones previstas, cero desapariciones y cero escrituras. Health `degraded`
   por horizonte desconocido y una taxonomía pendiente, no por fallos de transporte.

Los workflows de sonda sólo existen temporalmente en el historial de la PR.
La validación definitiva y el SHA probado quedan enlazados en su descripción.

4. [Validación definitiva 43248803116](https://github.com/gorfreee/clasica_madrid/actions/runs/43248803116),
   [artifact](https://github.com/gorfreee/clasica_madrid/actions/runs/43248803116/artifacts/13957228721),
   código `5cde0534fbf37e4ebfd96b0b0cccd216078a08c2`: mismo dry-run real y prueba
   adicional del endpoint Views GET con la programación general. Ambos pasos
   correctos. Incluye `report.json`, `run.json`, `events.jsonl` y la respuesta AJAX.
