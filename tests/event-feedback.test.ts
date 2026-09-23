import { describe, expect, it } from 'vitest';
import {
  cleanEventId,
  EVENT_FEEDBACK_ORIGIN,
  parseEventFeedbackContext,
  parseEventFeedbackSearch,
} from '../src/lib/contact/event-feedback.ts';
import { eventFeedbackPath } from '../src/lib/presentation/urls.ts';

const PUBLISHED_ID =
  'evt_casademexico_es_ecos_musicales_de_mexico_opera_nuestra_herencia_olvidada_raigambre_compositoras_mexicanas_del_period';
const PUBLISHED_SLUG =
  'xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma-26-orquesta-sinfonica-de-la-universidad-complutense';

describe('enlace de aviso en la ficha', () => {
  it('construye la query mínima de contacto', () => {
    expect(eventFeedbackPath('evt_carmen', 'carmen')).toBe(
      '/contacto/?motivo=correccion&event_id=evt_carmen&event_slug=carmen&origin=event_feedback',
    );
    const url = new URL(eventFeedbackPath(PUBLISHED_ID, PUBLISHED_SLUG), 'https://clasicamadrid.com');
    expect(url.pathname).toBe('/contacto/');
    expect(url.searchParams.get('motivo')).toBe('correccion');
    expect(url.searchParams.get('event_id')).toBe(PUBLISHED_ID);
    expect(url.searchParams.get('event_slug')).toBe(PUBLISHED_SLUG);
    expect(url.searchParams.get('origin')).toBe(EVENT_FEEDBACK_ORIGIN);
    expect([...url.searchParams.keys()]).toEqual(['motivo', 'event_id', 'event_slug', 'origin']);
  });
});

describe('contexto de corrección de ficha', () => {
  it('acepta un contexto completo y reconstruye el path', () => {
    expect(
      parseEventFeedbackSearch(
        `?motivo=correccion&event_id=${PUBLISHED_ID}&event_slug=${PUBLISHED_SLUG}&origin=event_feedback`,
      ),
    ).toEqual({
      origin: 'event_feedback',
      eventId: PUBLISHED_ID,
      eventSlug: PUBLISHED_SLUG,
      eventPath: `/eventos/${PUBLISHED_SLUG}/`,
    });
    expect(PUBLISHED_ID).toHaveLength(120);
    expect(PUBLISHED_SLUG).toHaveLength(120);
  });

  it('recorta espacios alrededor de un contexto válido', () => {
    expect(
      parseEventFeedbackContext({
        origin: ' event_feedback ',
        eventId: ' evt_carmen ',
        eventSlug: ' carmen ',
      }),
    ).toMatchObject({ eventId: 'evt_carmen', eventSlug: 'carmen', eventPath: '/eventos/carmen/' });
  });

  it.each([
    ['sin query', ''],
    ['solo el motivo', '?motivo=correccion'],
    ['sin origen', '?event_id=evt_carmen&event_slug=carmen'],
    ['origen distinto', '?origin=direct&event_id=evt_carmen&event_slug=carmen&motivo=correccion'],
    ['id de otro tipo', '?origin=event_feedback&event_id=ven_real&event_slug=carmen'],
    ['id vacío', '?origin=event_feedback&event_id=&event_slug=carmen'],
    ['id demasiado largo', `?origin=event_feedback&event_id=evt_${'a'.repeat(120)}&event_slug=carmen`],
    ['slug demasiado largo', `?origin=event_feedback&event_id=evt_carmen&event_slug=${'a'.repeat(121)}`],
    ['slug con mayúsculas', '?origin=event_feedback&event_id=evt_carmen&event_slug=Carmen'],
    ['slug con barras', '?origin=event_feedback&event_id=evt_carmen&event_slug=../secret'],
    ['url en el slug', '?origin=event_feedback&event_id=evt_carmen&event_slug=https://evil.example/eventos/x'],
    ['salto de línea en el id', '?origin=event_feedback&event_id=evt_carmen%0ABcc:%20evil@example.com&event_slug=carmen'],
    ['salto de línea en el origen', '?origin=event_feedback%0D%0ABcc:%20evil@example.com&event_id=evt_carmen&event_slug=carmen'],
  ])('no confía en un contexto incompleto o manipulado (%s)', (_label, search) => {
    expect(parseEventFeedbackSearch(search)).toBeNull();
  });

  it('no trata un id con caracteres de control como identificador', () => {
    expect(cleanEventId('evt_carmen\nBcc: evil@example.com')).toBeUndefined();
    expect(cleanEventId('evt_carmen\u2028')).toBe('evt_carmen');
    expect(cleanEventId(`evt_${'a'.repeat(116)}`)).toHaveLength(120);
    expect(cleanEventId(`evt_${'a'.repeat(117)}`)).toBeUndefined();
  });
});
