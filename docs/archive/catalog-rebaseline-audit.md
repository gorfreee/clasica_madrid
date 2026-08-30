# Rebaseline editorial del catálogo publicado

> **Documentación histórica.** Registro de una pasada editorial única (2026-08-29). **No** es el inventario actual del catálogo ni un requisito de implementación.
>
> La política editorial vigente está en [`docs/classification-policy.md`](../classification-policy.md). El catálogo publicado es `data/`. No uses los recuentos de este fichero como estado actual.
>
> Consérvese como contexto de aquellas decisiones. Las reglas generales que salieron de esta pasada ya viven en la Classification Policy.

Limpieza única del catálogo **legacy** después de la auditoría de Phase 2. La puerta de publicación no re-clasifica ni borra `data/**`; esta pasada sí aplicó las decisiones editoriales finales sobre los eventos ya publicados.

No implementa Phase 3 (harvesting, reconciliation, desapariciones, GitHub Actions ni auto-merge).

| | |
|---|---|
| Auditoría inicial | 2026-08-29 |
| Rebaseline aplicado | 2026-08-29 |
| Catálogo auditado | 52 eventos en `data/events/` |
| Catálogo resultante | 43 eventos |
| Criterio | [`docs/classification-policy.md`](classification-policy.md) (actualizada en esta pasada) |
| Hechos | JSON canónico, citations, fichas oficiales cuando hacía falta, golden set |
| Datos inventados | ninguno |

## Qué se hizo

1. Se auditó el catálogo publicado (52 eventos) contra la Classification Policy v1.
2. Una persona revisó los cubos KEEP / REMOVE / REVIEW.
3. Se aplicaron las decisiones finales: se eliminaron 9 eventos, se conservó el resto, se actualizó la política y el golden set.
4. No quedan eventos pendientes de REVIEW.

## Decisiones originales de la auditoría

| Decisión | N | Significado entonces |
|---|---|---|
| KEEP | 30 | Evidencia suficiente de ámbito Clásica Madrid |
| REMOVE | 9 | Evidencia suficiente de exclusión según la política de entonces |
| REVIEW | 13 | Evidencia insuficiente o ambigüedad editorial real |

La lista original de REMOVE incluía `evt_uam_raices_sinfonicas_20260926` (Gran Fiesta Canaria). La lista original de REVIEW incluía el Open Piano de Madrid a Tempo y otros 12 eventos que después se conservaron.

## Decisiones finales

Tras revisión humana:

| Decisión final | N | Cambio respecto a la auditoría |
|---|---|---|
| Conservar | 43 | KEEP original (30) + Gran Fiesta Canaria + 12 antiguos REVIEW |
| Eliminar | 9 | 8 REMOVE originales (sin Gran Fiesta Canaria) + Open Piano |
| Pendientes de REVIEW | 0 | Todos los REVIEW quedaron resueltos |

El recuento coincide con el catálogo de la auditoría (52 = 43 + 9).

### Gran Fiesta Canaria se conserva

`evt_uam_raices_sinfonicas_20260926` — *UAM. Raíces Sinfónicas. Gran Fiesta Canaria*.

La auditoría lo marcó REMOVE como evento mixto cuya identidad anunciada parecía la fiesta canaria. La revisión humana lo pasa a KEEP: es un concierto sinfónico real (Joven Orquesta de Canarias, Víctor Pablo Pérez, Juan Pérez Floristán) con un bloque clásico sustancial y autónomo (Saint-Saëns y Falla). La segunda parte es popular/canaria; eso no anula el bloque clásico.

Golden: `golden_raices_sinfonicas` → `include`.

### Antiguos REVIEW resueltos como KEEP

Estos 12 eventos se conservan en `data/events/**`:

- Candlelight: Tributo a Ludovico Einaudi
- Domingos de Cámara I
- Domingos de Cámara V
- Un recorrido por la historia de la música española
- Madrid a Tempo: Concierto de inauguración
- Madrid a Tempo: Jóvenes Talentos — Goethe-Institut
- Madrid a Tempo: Jóvenes Talentos — Sala Manuel de Falla / SGAE
- Madrid a Tempo: Jóvenes Talentos — Instituto Internacional
- Madrid a Tempo: Jóvenes Talentos — Hinves Pianos
- Madrid a Tempo: Concierto de clausura de alumnos
- Música que nos une
- Los sonidos del universo

`Madrid a Tempo: Open Piano` es el único antiguo REVIEW que pasa a REMOVE.

## Eventos eliminados (9)

No se han borrado venues, sources, organizers ni series compartidas.

| id | título | razón final |
|---|---|---|
| `evt_candlelight_hans_zimmer_cba_20260925` | Candlelight: Tributo a Hans Zimmer | Música de cine como contenido principal |
| `evt_candlelight_hans_zimmer_four_seasons_202609` | Candlelight: Lo mejor de Hans Zimmer | Música de cine como contenido principal |
| `evt_candlelight_lord_rings_20260920` | Candlelight: El Señor de los Anillos | Música de cine como contenido principal |
| `evt_candlelight_morricone_20260913` | Candlelight: Ennio Morricone | Música de cine como contenido principal |
| `evt_chano_dominguez_amor_brujo_20260923` | Chano Domínguez: El amor brujo de Rovira-Beleta | Cine-concierto + jazz-flamenco |
| `evt_jose_fiumara_clasico_pop_20260926` | José Fiumara: De clásico a lo Pop | Pop / canción popular con arreglo «clásico» |
| `evt_pagagnini_20260906` | PaGAGnini | Espectáculo de humor gestual / crossover |
| `evt_royal_gag_orchestra_202609` | Royal Gag Orchestra | Comedia musical; la identidad es el gag |
| `evt_madrid_tempo_open_piano_20260905` | Madrid a Tempo: Open Piano | Actividad participativa; no hay concierto programado |

## KEEP original (30)

Sin cambios. Siguen publicados los 30 eventos que la auditoría ya consideraba dentro de ámbito (ópera, zarzuela, sinfónico, cámara, órgano, early music, contemporánea académica, Candlelight Vivaldi y Babies, etc.).

## Classification Policy

La política se actualizó con reglas generales, no con excepciones por evento:

1. **Eventos mixtos (§1.4).** Un mixto puede ser `include` si hay un bloque clásico sustancial, autónomo e identificable y el evento se presenta como concierto clásico/sinfónico. Sigue `exclude` cuando lo clásico es acompañamiento, arreglo u ornamentación de pop, cine, jazz, flamenco, crossover, etc.
2. **Evidencia de ciclo/festival clásico (§1.3).** La falta de programa obra-por-obra no obliga siempre a `uncertain`. Un concierto real de un ciclo o festival explícitamente clásico, o de una formación clásica en una serie de identidad clásica establecida, puede ser `include`. Sigue sin ser automático por source ni venue.
3. **Contemporánea / neoclásica instrumental (§1.1).** El repertorio de piano de tradición concertística (p. ej. Einaudi) puede quedar dentro. Popularidad o carácter comercial no excluyen. Música de cine, pop/rock y crossover como identidad principal siguen fuera.
4. **Actividades participativas (§1.2).** Open piano, jam participativa u otras sesiones sin interpretación concertística programada no se publican. Un concierto del mismo festival se evalúa aparte.

## Golden set

Casos añadidos o actualizados para fijar estas decisiones:

| Caso | Expected | Notas |
|---|---|---|
| `golden_raices_sinfonicas` | `include` | Programa oficial con bloque Saint-Saëns/Falla y segunda parte popular |
| `golden_candlelight_einaudi` | `include` | Programa Fever de piano de Einaudi |
| `golden_domingos_camara_i` | `include` | Ficha de ciclo de cámara; sin obras de esa sesión |
| `golden_madrid_tempo_inauguracion` | `include` | Concierto del Festival Internacional de Piano |
| `golden_sonidos_universo` | `include` | Ficha municipal: concierto mixto clásica + bandas sonoras |
| `golden_madrid_tempo_open_piano` | `exclude` | Open piano / piano al aire libre |
| `golden_candlelight_zimmer` | `exclude` | Sin cambio; cine |
| `golden_abba_queen_beatles` y pop/crossover existentes | `exclude` | Sin cambio |

### Limitaciones (no se falsearon fixtures)

- **Música que nos une.** La ficha oficial devolvió 403; no hay programa observable. El evento se conserva en el catálogo. `golden_musica_que_nos_une` sigue `uncertain`: el classifier no puede alcanzar el KEEP editorial con esos hechos.
- **Los sonidos del universo.** La ficha describe un concierto mixto sin obras nombradas. El expected es `include` (decisión editorial). El núcleo determinista puede dejar `uncertain` (clásica y cine coprincipales). Un include esperado no debe convertirse en `exclude`.
- **Un recorrido por la historia de la música española** y los **Jóvenes Talentos** de Madrid a Tempo se conservan en el catálogo. No hay golden adicional: los hechos observados disponibles no añaden más que título de concierto/festival, cubierto por `golden_madrid_tempo_inauguracion` y la regla de ciclo clásico.

## Fuera de esta pasada

No se tocan matching de venues, `Sala Principal`, Madrid Datos ni el caso franco-flamenco. Esos cambios van en una PR técnica aparte.
