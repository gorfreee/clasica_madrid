# Auditoría del catálogo publicado vs Classification Policy v1

Limpieza humana asistida del catálogo **legacy**. La puerta de publicación de Phase 2 no re-clasifica ni borra `data/**`.

**Esta auditoría no modifica ningún fichero de `data/events/**`.**

| | |
|---|---|
| Fecha | 2026-08-29 |
| Catálogo | 52 eventos en `data/events/` |
| Criterio | [`docs/classification-policy.md`](classification-policy.md) v1 |
| Hechos | JSON canónico, citations, fichas oficiales cuando hacía falta, golden set si el mismo evento está representado |
| Datos inventados | ninguno |

## Resumen

| Decisión | N | Significado |
|---|---|---|
| KEEP | 30 | Evidencia suficiente de ámbito Clásica Madrid |
| REMOVE | 9 | Evidencia suficiente de exclusión según la política actual |
| REVIEW | 13 | Evidencia insuficiente o ambigüedad editorial real |

Una persona debe decidir qué REMOVE se eliminan antes de Phase 3. REVIEW no implica borrar.

---

## REMOVE (9)

| id | título | fecha | venue | URL | razón | evidencia | golden |
|---|---|---|---|---|---|---|---|
| `evt_candlelight_hans_zimmer_cba_20260925` | Candlelight: Tributo a Hans Zimmer | 2026-09-25 | Círculo de Bellas Artes | https://feverup.com/m/112052 | Música de cine como contenido principal | Programa: Time, El rey león, Interstellar, Gladiator, Dune, etc. | `golden_candlelight_zimmer` → exclude |
| `evt_candlelight_hans_zimmer_four_seasons_202609` | Candlelight: Lo mejor de Hans Zimmer | 2026-09-06, 2026-09-26 | Four Seasons Hotel Madrid | https://feverup.com/m/118384 | Música de cine como contenido principal | Mismo repertorio Zimmer / bandas sonoras | — |
| `evt_candlelight_lord_rings_20260920` | Candlelight: El Señor de los Anillos | 2026-09-20 | Hotel Wellington | https://feverup.com/m/524089 | Música de cine como contenido principal | Howard Shore: Concerning Hobbits, Minas Tirith, Into the West, etc. | — |
| `evt_candlelight_morricone_20260913` | Candlelight: Ennio Morricone | 2026-09-13 | Ateneo de Madrid | https://feverup.com/m/395277 | Música de cine (Morricone explícito en la política) | Cinema Paradiso, The Mission, Once Upon a Time in the West, etc. | — |
| `evt_chano_dominguez_amor_brujo_20260923` | Chano Domínguez: El amor brujo de Rovira-Beleta | 2026-09-23 | Condeduque | https://www.condeduquemadrid.es/actividades/chano-dominguez-el-amor-brujo-de-rovira-beleta | Cine-concierto + jazz-flamenco; la actividad principal es ver/acompañar una película | Ficha Condeduque: «cine-concierto», estilo «Jazz-flamenco», proyección de *El amor brujo* (1967) con piano en directo | — |
| `evt_jose_fiumara_clasico_pop_20260926` | José Fiumara: De clásico a lo Pop | 2026-09-26 | Jardín Bulevar de Peña Gorbea | https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Vicalvaro/Jose-Fiumara-De-clasico-a-lo-Pop/?vgnextchannel=f4c1ca5d5fb96010VgnVCM100000dc0ca8c0RCRD&vgnextfmt=default&vgnextoid=1bfc56066dbdf910VgnVCM100000891ecb1aRCRD | Pop / canción popular con arreglo «clásico» | Título y ficha municipal: identidad anunciada «de clásico a lo Pop»; sin repertorio clásico declarado | — |
| `evt_pagagnini_20260906` | PaGAGnini | 2026-09-06 | Gran Teatro Príncipe Pío | https://yllana.com/espectaculo/pagagnini/ | Espectáculo de humor gestual / crossover; no es un concierto de repertorio clásico | Yllana + Ara Malikian: «Des-Concierto», fusión con pop/rock, parodia de recital | — |
| `evt_royal_gag_orchestra_202609` | Royal Gag Orchestra | 2026-09-03 … 2026-09-13 | Gran Teatro Príncipe Pío | https://guiadelocio.es/madrid/plan/the-royal-gag-orchestra-yllana-convierte-un-concierto-de-musica-clasica-en-una-comedia/ | Comedia musical; la identidad es el gag, no el concierto | Yllana / Sing_Us: teatro gestual que convierte un concierto en batalla de egos | — |
| `evt_uam_raices_sinfonicas_20260926` | UAM. Raíces Sinfónicas. Gran Fiesta Canaria | 2026-09-26 | Auditorio Nacional — Sala Sinfónica | https://auditorionacional.inaem.gob.es/es/programacion/uam-raices-sinfonicas-gran-fiesta-canaria | Evento mixto cuya identidad anunciada es la fiesta canaria / folklore popular | 1.ª parte Falla/Saint-Saëns; 2.ª parte Los Sabandeños (Guanche, Tenerife, Unicornio, Dos Cruces…). Política §1.4: si la identidad anunciada es el bloque no clásico → exclude | — |

---

## REVIEW (13)

| id | título | fecha | venue | URL | razón | evidencia | golden |
|---|---|---|---|---|---|---|---|
| `evt_candlelight_einaudi_20260927` | Candlelight: Tributo a Ludovico Einaudi | 2026-09-27 | Círculo de Bellas Artes | https://feverup.com/m/135802 | Einaudi / producto Candlelight: contemporáneo comercial, no claramente tradición académica | Programa Fever: I Giorni, Nuvole Bianche, Divenire… Tributo no avalado por el compositor. No es cine; tampoco un ciclo CNDM/COMA | — |
| `evt_domingos_camara_i_202609` | Domingos de Cámara I | 2026-09-27 | Teatro Real | https://www.teatroreal.es/es/espectaculo/domingos-camara-i | Título genérico de ciclo; la ficha no declara programa | Solistas de la Orquesta Titular; `composers`/`works` vacíos en el canónico | `golden_domingos_camara_i` → uncertain |
| `evt_domingos_camara_v_202609` | Domingos de Cámara V 25-26 | 2026-09-13 | Teatro Real | https://www.teatroreal.es/es/espectaculo/domingos-camara-v | Igual: ciclo de cámara sin repertorio observable | Mismos hechos que el caso I | — |
| `evt_historia_musica_espanola_20260924` | Un recorrido por la historia de la música española — concierto benéfico | 2026-09-24 | San Antonio de los Alemanes | https://realhermandaddelrefugio.org/calendario-de-eventos/un-recorrido-por-la-historia-de-la-musica-espanola-concierto-benefico/ | Título sugiere clásica española; no hay programa | Canónico: `composers`/`works`/`performers` vacíos | — |
| `evt_madrid_tempo_inauguracion_20260901` | Madrid a Tempo: Concierto de inauguración | 2026-09-01 | Ateneo de Madrid | https://www.madridatempo.com/programacion-2023 | Festival de piano / jóvenes; la web no lista obras | Agenda del festival: hora y sede, sin repertorio | — |
| `evt_madrid_tempo_jovenes_goethe_20260902` | Madrid a Tempo: Jóvenes Talentos — Goethe-Institut | 2026-09-02 | Goethe-Institut Madrid | https://www.madridatempo.com/programacion-2023 | Recital de jóvenes talentos sin programa | Idem | — |
| `evt_madrid_tempo_jovenes_sgae_20260903` | Madrid a Tempo: Jóvenes Talentos — Sala Manuel de Falla | 2026-09-03 | SGAE | https://www.madridatempo.com/programacion-2023 | Idem | Idem | — |
| `evt_madrid_tempo_jovenes_iie_20260904` | Madrid a Tempo: Jóvenes Talentos — Instituto Internacional | 2026-09-04 | Instituto Internacional | https://www.madridatempo.com/programacion-2023 | Idem | Idem | — |
| `evt_madrid_tempo_jovenes_hinves_20260905` | Madrid a Tempo: Jóvenes Talentos — Hinves Pianos | 2026-09-05 | Hinves Pianos | https://www.madridatempo.com/programacion-2023 | Idem | Idem | — |
| `evt_madrid_tempo_open_piano_20260905` | Madrid a Tempo: Open Piano | 2026-09-05 | Puente de Toledo | https://www.madridatempo.com/programacion-2023 | Piano al aire libre; hechos insuficientes | Web: horario y lugar, sin repertorio | `golden_madrid_tempo_open_piano` → uncertain |
| `evt_madrid_tempo_clausura_20260906` | Madrid a Tempo: Concierto de clausura de alumnos | 2026-09-06 | Casa de Vacas | https://www.madridatempo.com/programacion-2023 | Concierto de alumnos sin programa | Idem | — |
| `evt_musica_que_nos_une_20260926` | Música que nos une | 2026-09-26 | San Antonio de los Alemanes | https://realhermandaddelrefugio.org/calendario-de-eventos/musica-que-nos-une-concierto/ | Concierto parroquial; repertorio no declarado | Capilla Musical San Antonio; sin obras | `golden_musica_que_nos_une` → uncertain |
| `evt_sonidos_universo_20260927` | Los sonidos del universo | 2026-09-27 | Parque Lineal de Palomeras | https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Ciudad-Lineal/Retransmision-del-Pleno-en-directo/Actuacion-musica-Musica-clasica/?vgnextchannel=cd0a32e941f22610VgnVCM1000008a4a900aRCRD&vgnextfmt=default&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD | Título poético municipal; la ficha no demuestra repertorio clásico | Canónico sin compositores ni obras; URL de distrito | `golden_sonidos_universo` → uncertain |

---

## KEEP (30)

Resumen compacto. Hay evidencia de interpretación de repertorio clásico / académico (ópera, zarzuela, sinfónico, cámara, órgano, early music, contemporánea de tradición clásica).

| id | título | fecha | nota breve |
|---|---|---|---|
| `evt_andromeda_perseo_escolares_2026` | Andrómeda y Perseo — escolares | 2026-09-29… | Ópera barroca de Juan Hidalgo; concierto real (no taller) |
| `evt_andromeda_perseo_publico_2026` | Andrómeda y Perseo | 2026-09-30… | Idem, público general |
| `evt_arturo_barba_organo_20260926` | Arturo Barba — ciclo de órgano | 2026-09-26 | `golden_arturo_barba` → include |
| `evt_bayreuth_wagner_20260903` | Orquesta del Festival de Bayreuth | 2026-09-03 | Wagner, *El anillo* (selección) |
| `evt_candlelight_babies_20260920` | Candlelight Babies: clásicos | 2026-09-20 | Programa Vivaldi, Bach, Mozart, Beethoven, Brahms, Saint-Saëns |
| `evt_candlelight_vivaldi_20260925` | Candlelight: Las Cuatro Estaciones | 2026-09-25 | `golden_candlelight_vivaldi` → include |
| `evt_coma_atlantida_20260922` | COMA'26: Atlántida Chamber Orchestra | 2026-09-22 | Festival de música contemporánea académica |
| `evt_coma_coro_cam_20260926` | COMA'26: Coro de la Comunidad de Madrid | 2026-09-26 | Idem, coral |
| `evt_coma_spanish_brass_20260930` | COMA'26: Spanish Brass | 2026-09-30 | Idem, chamber |
| `evt_contendientes_leipzig_20260918` | Los contendientes de Leipzig | 2026-09-18 | Telemann, Museo del Prado |
| `evt_ecos_tres_culturas_20260912` | Ecos de las Tres Culturas | 2026-09-12 | `golden_ecos_tres_culturas` → include |
| `evt_excelentia_chaikovsky_sibelius_20260930` | Violín Chaikovsky / Sibelius 2 | 2026-09-30 | Dvořák, Chaikovsky, Sibelius |
| `evt_festival_ensembles_vertixe_20260923` | Vertixe Sonora | 2026-09-23 | `golden_vertixe_sonora` → include |
| `evt_in_honour_moon_20260910` | In Honour of the Moon | 2026-09-10 | Cámara contemporánea (O'Donnell) |
| `evt_manon_lescaut_reparto_a_202609` | Manon Lescaut — Radvanovsky | 2026-09-23… | `golden_manon_lescaut` → include |
| `evt_manon_lescaut_reparto_b_202609` | Manon Lescaut — Hernández | 2026-09-24… | Misma ópera, otro reparto |
| `evt_miniclasica_voz_guitarra_202609` | Miniclásica: voz y guitarra | 2026-09-26… | `golden_miniclasica_voz` → include |
| `evt_ocne_sinfonico_01_202609` | OCNE. Sinfónico 01 | 2026-09-18… | `golden_ocne_sinfonico_01` → include (Mahler 2) |
| `evt_ocne_sinfonico_02_202609` | OCNE. Sinfónico 02 | 2026-09-25… | Sibelius, Giménez-Comas, Beethoven 7 |
| `evt_organo_realejo_man_20260927` | Órgano realejo, MAN | 2026-09-27 | Ciclo concertístico de órgano en museo (análogo a Arturo Barba) |
| `evt_paraisos_nocturnos_20260930` | Paraísos nocturnos | 2026-09-30 | Marco, Vega, Greco, del Puerto, Torres |
| `evt_preestreno_joven_manon_20260920` | Preestreno Joven Manon Lescaut | 2026-09-20 | Función de la ópera, no taller |
| `evt_schubert_otra_mirada_20260927` | Schubert desde otra mirada | 2026-09-27 | Octeto D 803 |
| `evt_tabernera_a_20260902` | La tabernera del puerto — Albarrán/Moncloa | 2026-09-02 | Zarzuela de Sorozábal |
| `evt_tabernera_b_20260903` | La tabernera del puerto — Albarrán/Rossi | 2026-09-03 | Idem |
| `evt_tabernera_c_20260904` | La tabernera del puerto — Oria/Moncloa | 2026-09-04 | Idem |
| `evt_traviata_a_20260905` | La traviata — Cárdenas/Rossi | 2026-09-05 | Verdi |
| `evt_traviata_b_20260906` | La traviata — Oria/Moncloa | 2026-09-06 | Verdi |
| `evt_verbena_paloma_reparto_a_202609` | La verbena de la Paloma — reparto A | 2026-09-23… | `golden_verbena_paloma` → include |
| `evt_verbena_paloma_reparto_b_202609` | La verbena de la Paloma — reparto B | 2026-09-24… | Idem |

---

## Notas

- Candlelight **Vivaldi** y **Babies** se conservan porque el repertorio observado es clásico; Candlelight **Zimmer / Shore / Morricone** no.
- Einaudi se deja en REVIEW a propósito: no hay golden y la frontera popular/académica es editorial.
- Los Madrid a Tempo son un festival de piano plausible, pero la fuente no declara obras: la política exige `uncertain` en ese caso.
- Nada de lo anterior se ha aplicado al catálogo. El siguiente paso humano es borrar o conservar los REMOVE/REVIEW **antes** de Phase 3.
