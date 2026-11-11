import { describe, expect, it } from 'vitest';
import { buildEventSourceAction } from '../src/lib/presentation/external-action.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { shareSeveralDatesLabel } from '../src/lib/presentation/labels.ts';
import {
  attributedShareUrl,
  buildEventShare,
  buildVenueShare,
  canonicalSharePath,
  canonicalShareUrl,
  canUseWebShare,
  formatShareDate,
  isShareCancellation,
  planShareMenuPlacement,
  whatsappShareHref,
} from '../src/lib/presentation/share.ts';
import { publicUrl } from '../src/lib/presentation/urls.ts';
import { buildVenuePageModel } from '../src/lib/presentation/venue.ts';
import { makeCatalog, makeEvent, richCatalog, testClock } from './helpers.ts';

describe('texto para compartir un evento', () => {
  it('incluye título, fecha, hora y lugar cuando hay una sola función', () => {
    const share = buildEventShare({
      title: 'Réquiem de Mozart',
      venueName: 'Auditorio Nacional de Música',
      path: '/eventos/requiem-de-mozart/',
      occurrences: [{ date: '2026-10-18', time: '19:30', isCancelled: false }],
    });

    expect(formatShareDate('2026-10-18')).toBe('18 de octubre');
    expect(share).toEqual({
      title: 'Réquiem de Mozart',
      text: 'Réquiem de Mozart — 18 de octubre, 19:30 · Auditorio Nacional de Música',
      path: '/eventos/requiem-de-mozart/',
    });
  });

  it('omite la hora si no existe y no inventa un aviso', () => {
    const share = buildEventShare({
      title: 'Recital de órgano',
      venueName: 'Iglesia de San Manuel',
      path: '/eventos/recital-de-organo/',
      occurrences: [{ date: '2026-09-10', time: null, isCancelled: false }],
    });

    expect(share.text).toBe('Recital de órgano — 10 de septiembre · Iglesia de San Manuel');
    expect(share.text.toLowerCase()).not.toContain('confirmar');
  });

  it('no presenta una función como si fuera la única cuando hay varias', () => {
    const share = buildEventShare({
      title: 'Carmen',
      venueName: 'Teatro Real',
      path: '/eventos/carmen/',
      occurrences: [
        { date: '2026-09-10', time: '19:00', isCancelled: false },
        { date: '2026-09-12', time: '19:00', isCancelled: true },
        { date: '2026-09-14', time: '18:00', isCancelled: false },
      ],
    });

    expect(share.title).toBe('Carmen');
    expect(share.text).toBe(`Carmen · Teatro Real — ${shareSeveralDatesLabel}`);
    expect(share.text).not.toMatch(/\d{1,2} de /);
    expect(share.text).not.toContain('19:00');
  });

  it('usa la única función no cancelada aunque haya otra fecha anulada', () => {
    const share = buildEventShare({
      title: 'Matinées de otoño',
      venueName: 'Auditorio Nacional de Música',
      path: '/eventos/matinees-de-otono/',
      occurrences: [
        { date: '2026-09-12', time: '12:00', isCancelled: true },
        { date: '2026-09-15', time: '19:30', isCancelled: false },
      ],
    });

    expect(share.text).toBe('Matinées de otoño — 15 de septiembre, 19:30 · Auditorio Nacional de Música');
  });

  it('degrada sin fecha ni lugar cuando esos datos no existen', () => {
    expect(
      buildEventShare({
        title: 'Ensayo abierto',
        venueName: '',
        path: '/eventos/ensayo-abierto/',
        occurrences: [],
      }).text,
    ).toBe('Ensayo abierto');

    expect(
      buildEventShare({
        title: 'Ciclo',
        venueName: 'Teatro Real',
        path: '/eventos/ciclo/',
        occurrences: [{ date: '2026-09-01', time: '19:00', isCancelled: true }],
      }).text,
    ).toBe('Ciclo · Teatro Real');
  });

  it('no arrastra intérpretes, precios ni la descripción larga de la ficha', () => {
    const catalog = richCatalog();
    const model = buildEventPageModel(catalog, 'carmen', testClock);
    expect(model).not.toBeNull();
    const share = buildEventShare({
      title: model!.title,
      venueName: model!.venueName,
      path: model!.canonicalPath,
      occurrences: model!.occurrences,
    });

    expect(share.text).toBe('Carmen · Auditorio Nacional de Música — varias fechas');
    expect(share.text).not.toContain('Bizet');
    expect(share.text).not.toContain('Orquesta');
    expect(share.path).toBe('/eventos/carmen/');
    expect(model!.sourceAction).not.toBeNull();
  });

  it('sigue teniendo texto cuando la ficha no tiene acción de fuente', () => {
    expect(buildEventSourceAction([])).toBeNull();
    const model = buildEventPageModel(makeCatalog({ events: [makeEvent()] }), 'matinees-de-otono', testClock);
    const share = buildEventShare({
      title: model!.title,
      venueName: model!.venueName,
      path: model!.canonicalPath,
      occurrences: model!.occurrences,
    });

    expect(share.title).toBe('Matinées de otoño');
    expect(share.text).toContain('Auditorio Nacional de Música');
    expect(share.text).toContain('15 de septiembre, 19:30');
  });
});

describe('texto para compartir un lugar', () => {
  it('une el nombre y el municipio cuando aporta información', () => {
    expect(
      buildVenueShare({
        name: 'Auditorio Nacional de Música',
        municipality: 'Madrid',
        path: '/lugares/auditorio-nacional-de-musica/',
      }),
    ).toEqual({
      title: 'Auditorio Nacional de Música',
      text: 'Auditorio Nacional de Música · Madrid',
      path: '/lugares/auditorio-nacional-de-musica/',
    });
  });

  it('no repite el municipio si el nombre ya lo contiene', () => {
    expect(
      buildVenueShare({
        name: 'Auditorio de Alcobendas',
        municipality: 'Alcobendas',
        path: '/lugares/auditorio-de-alcobendas/',
      }).text,
    ).toBe('Auditorio de Alcobendas');
  });

  it('sale del modelo de la ficha, no del listado', () => {
    const model = buildVenuePageModel(richCatalog(), 'iglesia-san-manuel', testClock);
    const share = buildVenueShare({
      name: model!.name,
      municipality: model!.municipality,
      path: model!.canonicalPath,
    });

    expect(share.text).toBe('Iglesia de San Manuel · Alcobendas');
    expect(share.path).toBe('/lugares/iglesia-san-manuel/');
  });
});

describe('url canónica y WhatsApp', () => {
  it('usa el origin de ejecución y elimina query y hash', () => {
    expect(canonicalShareUrl('https://clasicamadrid.com', '/eventos/carmen/?utm=1#programa')).toBe(
      'https://clasicamadrid.com/eventos/carmen/',
    );
    expect(canonicalShareUrl('http://localhost:4321', '/lugares/teatro-real')).toBe(
      'http://localhost:4321/lugares/teatro-real/',
    );
    expect(canonicalShareUrl('https://preview.example/', '/eventos/norma/')).toBe(
      'https://preview.example/eventos/norma/',
    );
  });

  it('codifica el texto y la url en wa.me sin un teléfono', () => {
    const href = whatsappShareHref(
      'Carmen · Teatro Real — varias fechas',
      'https://clasicamadrid.com/eventos/carmen/',
    );

    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    expect(href).not.toMatch(/wa\.me\/\d/);
    expect(new URL(href).searchParams.get('text')).toBe(
      'Carmen · Teatro Real — varias fechas\nhttps://clasicamadrid.com/eventos/carmen/',
    );
  });
});

describe('atribución de las URLs compartidas', () => {
  const dirty = '/eventos/carmen/?utm=boletin&utm_campaign=abril#programa';

  it('la URL canónica y las URLs públicas siguen sin parámetros', () => {
    expect(canonicalShareUrl('https://clasicamadrid.com', dirty)).toBe(
      'https://clasicamadrid.com/eventos/carmen/',
    );
    expect(new URL(canonicalShareUrl('https://clasicamadrid.com', dirty)).search).toBe('');
    expect(publicUrl('/eventos/carmen')).toBe('https://clasicamadrid.com/eventos/carmen/');
    expect(new URL(publicUrl('/lugares/teatro-real')).search).toBe('');
    expect(canonicalSharePath(dirty)).toBe('/eventos/carmen/');
  });

  it('el compartir nativo añade solo utm_source y utm_medium', () => {
    const url = attributedShareUrl('https://clasicamadrid.com', dirty, 'native_share');
    expect(url).toBe(
      'https://clasicamadrid.com/eventos/carmen/?utm_source=native_share&utm_medium=share',
    );
    expect([...new URL(url).searchParams.keys()]).toEqual(['utm_source', 'utm_medium']);
    expect(url).not.toContain('utm_campaign');
    expect(url).not.toContain('boletin');
    expect(url).not.toContain('#');
  });

  it('WhatsApp usa su propia URL atribuida, sin la query ni el hash de la visita', () => {
    const url = attributedShareUrl('http://localhost:4321', '/lugares/teatro-real?origen=preview#mapa', 'whatsapp');
    expect(url).toBe('http://localhost:4321/lugares/teatro-real/?utm_source=whatsapp&utm_medium=share');

    const href = whatsappShareHref('Teatro Real · Madrid', url);
    expect(new URL(href).searchParams.get('text')).toBe(`Teatro Real · Madrid\n${url}`);
    expect(decodeURIComponent(href)).not.toContain('origen=preview');
    expect(decodeURIComponent(href)).not.toContain('#mapa');
  });

  it('copiar enlace usa su propia URL atribuida', () => {
    expect(attributedShareUrl('https://preview.example/', dirty, 'copy_link')).toBe(
      'https://preview.example/eventos/carmen/?utm_source=copy_link&utm_medium=share',
    );
  });
});

describe('detección de Web Share y posición del menú', () => {
  it('solo usa Web Share cuando la capacidad existe y los datos son compartibles', () => {
    const data = { title: 'Carmen', text: 'Carmen', url: 'https://clasicamadrid.com/eventos/carmen/' };
    expect(canUseWebShare({}, data)).toBe(false);
    expect(canUseWebShare({ share: () => Promise.resolve() }, data)).toBe(true);
    expect(
      canUseWebShare({ share: () => Promise.resolve(), canShare: () => false }, data),
    ).toBe(false);
    expect(
      canUseWebShare(
        {
          share: () => Promise.resolve(),
          canShare: () => {
            throw new Error('no');
          },
        },
        data,
      ),
    ).toBe(false);
  });

  it('trata la cancelación nativa como un cierre sin error', () => {
    expect(isShareCancellation(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true);
    expect(isShareCancellation({ name: 'AbortError' })).toBe(true);
    expect(isShareCancellation(new Error('fallo'))).toBe(false);
    expect(isShareCancellation(new DOMException('Not allowed', 'NotAllowedError'))).toBe(false);
  });

  it('vuelca el menú hacia dentro cuando el disparador está junto al borde', () => {
    expect(
      planShareMenuPlacement({
        triggerLeft: 16,
        triggerWidth: 120,
        menuWidth: 180,
        menuHeight: 96,
        viewportWidth: 1280,
        viewportHeight: 800,
        triggerTop: 240,
        triggerBottom: 284,
      }),
    ).toMatchObject({ alignEnd: false, alignAbove: false, offsetLeft: null });

    expect(
      planShareMenuPlacement({
        triggerLeft: 1100,
        triggerWidth: 140,
        menuWidth: 200,
        menuHeight: 96,
        viewportWidth: 1280,
        viewportHeight: 800,
        triggerTop: 240,
        triggerBottom: 284,
      }).alignEnd,
    ).toBe(true);

    const pinned = planShareMenuPlacement({
      triggerLeft: 40,
      triggerWidth: 80,
      menuWidth: 300,
      menuHeight: 96,
      viewportWidth: 320,
      viewportHeight: 700,
      triggerTop: 80,
      triggerBottom: 124,
    });
    expect(pinned.alignEnd).toBe(false);
    expect(pinned.offsetLeft).toBe(8 - 40);
    expect(pinned.maxWidth).toBe(304);

    expect(
      planShareMenuPlacement({
        triggerLeft: 16,
        triggerWidth: 120,
        menuWidth: 180,
        menuHeight: 160,
        viewportWidth: 390,
        viewportHeight: 700,
        triggerTop: 620,
        triggerBottom: 664,
      }).alignAbove,
    ).toBe(true);
  });
});
