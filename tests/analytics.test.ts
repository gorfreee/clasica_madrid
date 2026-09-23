import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { madridWeekendRange } from '../src/lib/domain/dates.ts';
import {
  countActiveAgendaFilters,
  planAgendaAnalytics,
} from '../src/lib/analytics/agenda-actions.ts';
import { claimOnce, publishEventOpened } from '../src/lib/analytics/browser.ts';
import type { AnalyticsProperties } from '../src/lib/analytics/capture.ts';
import { claimListExhaustion, resultsEndTag, staticResultsObservation, syncResultsEnd } from '../src/lib/analytics/list-end.ts';
import { flushLiveSearch, initialLiveSearchState, reduceLiveSearch, settledLiveSearchQuery } from '../src/lib/analytics/live-search.ts';
import { inferNavigationOrigin } from '../src/lib/analytics/origin.ts';
import {
  buildPageAnalytics,
  daysUntilEvent,
  inferPageType,
  isFreeAccess,
  landingQuickFilter,
  pageviewBeforeSendSource,
} from '../src/lib/analytics/page.ts';
import { posthogBootstrapScript, posthogInitConfig } from '../src/lib/analytics/posthog.ts';
import {
  CONTACT_SUBMITTED,
  CONTACT_TOPICS,
  destinationDomain,
  EVENT_OPENED,
  FILTER_CHANGED,
  FILTER_CLEARED,
  onOutboundClick,
  OUTBOUND_EVENT_CLICK,
  QUICK_FILTER_SELECTED,
  RESULT_LIST_EXHAUSTED,
  SEARCH_PERFORMED,
  trackContactSubmitted,
  trackOutboundEventClick,
  trackResultListExhausted,
  trackSearchPerformed,
  trackShareClicked,
  trackWhatsAppChannelClicked,
  WHATSAPP_CHANNEL_CLICKED,
  WHATSAPP_CHANNEL_PLACEMENTS,
  isWhatsAppChannelPlacement,
} from '../src/lib/analytics/product.ts';
import { WHATSAPP_CHANNEL_URL } from '../src/lib/presentation/constants.ts';
import { CONTACT_REASONS } from '../functions/api/contacto.ts';
import { isAgendaShortcutId } from '../src/lib/presentation/agenda-shortcut-id.ts';
import { venueResultsEndForSearch } from '../src/lib/presentation/venue-search-client.ts';

const NOW = new Date('2026-09-22T12:00:00+02:00');
const PAGE = 'https://clasicamadrid.com/eventos/carmen/';

type Call = { event: string; properties: AnalyticsProperties };

function recorder(): { calls: Call[]; capture: (event: string, properties: AnalyticsProperties) => void } {
  const calls: Call[] = [];
  return {
    calls,
    capture: (event, properties) => calls.push({ event, properties }),
  };
}

describe('page context', () => {
  it('clasifica las rutas públicas sin inventar otro pageview', () => {
    expect(inferPageType('/')).toBe('agenda');
    expect(inferPageType('/agenda/gratis/')).toBe('agenda_landing');
    expect(inferPageType('/eventos/carmen')).toBe('event');
    expect(inferPageType('/lugares/')).toBe('venues');
    expect(inferPageType('/lugares/teatro-real/')).toBe('venue');
    expect(inferPageType('/acerca-de/')).toBe('about');
    expect(inferPageType('/contacto/')).toBe('contact');
    expect(inferPageType('/no-existe/')).toBe('other');
  });

  it('deja is_free solo cuando el acceso es inequívoco y conserva 0 y false', () => {
    expect(isFreeAccess('free')).toBe(true);
    expect(isFreeAccess('paid')).toBe(false);
    expect(isFreeAccess('unknown')).toBeUndefined();
    const page = buildPageAnalytics('/eventos/carmen/', {
      page_type: 'event',
      event_id: 'evt_carmen',
      event_title: '  Carmen  ',
      venue_id: 'ven_real',
      access: 'paid',
      is_free: false,
      format: 'opera',
      era: 'romantic',
      days_until_event: 0,
    });
    expect(page).toEqual({
      page_type: 'event',
      event_id: 'evt_carmen',
      event_title: 'Carmen',
      venue_id: 'ven_real',
      access: 'paid',
      is_free: false,
      format: 'opera',
      era: 'romantic',
      days_until_event: 0,
    });
    expect(buildPageAnalytics('/', { access: 'nope', format: 'nope' })).toEqual({ page_type: 'agenda' });
  });

  it('enriquece $pageview y $pageleave sin duplicarlos ni pegar el contexto a otros eventos', () => {
    const beforeSend = compileBeforeSend(
      JSON.stringify({
        page_type: 'event',
        event_id: 'evt_carmen',
        is_free: false,
        days_until_event: 0,
        email: 'ada@example.com',
        message: 'secreto',
      }),
    );
    const pageview = beforeSend({ event: '$pageview', properties: { $current_url: 'https://clasicamadrid.com/eventos/carmen/' } });
    const again = beforeSend(pageview);
    expect(pageview.event).toBe('$pageview');
    expect(pageview.properties).toMatchObject({
      page_type: 'event',
      event_id: 'evt_carmen',
      is_free: false,
      days_until_event: 0,
    });
    expect(pageview.properties).not.toHaveProperty('email');
    expect(pageview.properties).not.toHaveProperty('message');
    expect(again).toBe(pageview);

    const custom = { event: 'event_opened', properties: { event_id: 'evt_carmen' } };
    expect(beforeSend(custom)).toEqual(custom);
    expect(beforeSend({ event: '$pageleave', properties: {} }).properties).toMatchObject({ page_type: 'event' });
    expect(compileBeforeSend(null)({ event: '$pageview', properties: { a: 1 } }).properties).toEqual({ a: 1 });
    expect(compileBeforeSend('{')({ event: '$pageview', properties: { a: 1 } }).properties).toEqual({ a: 1 });
    expect(pageviewBeforeSendSource()).toContain('"$pageview"');
    expect(posthogBootstrapScript('phc_example')).toContain(pageviewBeforeSendSource());
  });
});

describe('origin', () => {
  const weekend = madridWeekendRange(NOW);

  it('distingue agenda, búsqueda, atajo, lugar, externo y directo', () => {
    expect(inferNavigationOrigin('', PAGE, NOW)).toBe('direct');
    expect(inferNavigationOrigin('https://www.google.com/search?q=carmen', PAGE, NOW)).toBe('external');
    expect(inferNavigationOrigin('https://clasicamadrid.com/', PAGE, NOW)).toBe('agenda');
    expect(inferNavigationOrigin('https://clasicamadrid.com/?q=bach', PAGE, NOW)).toBe('search');
    expect(inferNavigationOrigin('https://clasicamadrid.com/?q=bach&access=free', PAGE, NOW)).toBe('search');
    expect(
      inferNavigationOrigin(
        `https://clasicamadrid.com/?from=${weekend.from}&to=${weekend.to}`,
        PAGE,
        NOW,
      ),
    ).toBe('quick_filter');
    expect(inferNavigationOrigin('https://clasicamadrid.com/?access=free', PAGE, NOW)).toBe('quick_filter');
    expect(inferNavigationOrigin('https://clasicamadrid.com/?format=opera', PAGE, NOW)).toBe('agenda');
    expect(inferNavigationOrigin('https://clasicamadrid.com/lugares/teatro-real/', PAGE, NOW)).toBe('venue');
    expect(inferNavigationOrigin('https://clasicamadrid.com/lugares/', PAGE, NOW)).toBe('internal');
    expect(inferNavigationOrigin('https://clasicamadrid.com/agenda/gratis/', PAGE, NOW)).toBe('quick_filter');
    expect(inferNavigationOrigin('https://clasicamadrid.com/agenda/gratis', PAGE, NOW)).toBe('quick_filter');
    expect(inferNavigationOrigin('https://clasicamadrid.com/agenda/fin-de-semana/', PAGE, NOW)).toBe('quick_filter');
    expect(inferNavigationOrigin('https://clasicamadrid.com/agenda/opera/', PAGE, NOW)).toBe('agenda');
    expect(inferNavigationOrigin('https://clasicamadrid.com/agenda/', PAGE, NOW)).toBe('agenda');
    expect(inferNavigationOrigin('not a url', PAGE, NOW)).toBe('unknown');
  });

  it('solo gratis y fin de semana son el atajo de la landing', () => {
    expect(landingQuickFilter('gratis')).toBe('free');
    expect(landingQuickFilter('fin-de-semana')).toBe('weekend');
    expect(landingQuickFilter('opera')).toBeUndefined();
    expect(landingQuickFilter(undefined)).toBeUndefined();
  });
});

describe('agenda analytics', () => {
  it('no dispara filtros ni búsqueda al inicializar o al volver atrás', () => {
    const input = {
      interaction: { kind: 'submit' as const },
      previous: {},
      next: { q: 'bach', format: 'opera' as const },
      resultsBefore: 20,
      resultsCount: 0,
      now: NOW,
    };
    expect(planAgendaAnalytics({ ...input, reason: 'init' })).toEqual([]);
    expect(planAgendaAnalytics({ ...input, reason: 'popstate' })).toEqual([]);
  });

  it('registra una búsqueda, también con cero resultados, y no repite la misma query', () => {
    const { calls, capture } = recorder();
    const actions = planAgendaAnalytics({
      reason: 'user',
      interaction: { kind: 'submit' },
      previous: {},
      next: { q: '  bach  ' },
      resultsBefore: 20,
      resultsCount: 0,
      now: NOW,
    });
    expect(actions.map((action) => action.event)).toEqual([SEARCH_PERFORMED]);
    trackSearchPerformed(
      { surface: 'agenda', query: '  bach  ', results_count: 0, active_filter_count: 0 },
      capture,
    );
    expect(calls).toEqual([
      {
        event: SEARCH_PERFORMED,
        properties: { surface: 'agenda', query: 'bach', results_count: 0, active_filter_count: 0 },
      },
    ]);
    expect(
      planAgendaAnalytics({
        reason: 'user',
        interaction: { kind: 'submit' },
        previous: { q: 'bach' },
        next: { q: 'bach' },
        resultsBefore: 0,
        resultsCount: 0,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('un atajo usa su id estable y no emite filter_changed por los campos que escribe', () => {
    const weekend = madridWeekendRange(NOW);
    const selected = planAgendaAnalytics({
      reason: 'user',
      interaction: { kind: 'shortcut', shortcut: 'weekend' },
      previous: {},
      next: { from: weekend.from, to: weekend.to },
      resultsBefore: 40,
      resultsCount: 6,
      now: NOW,
    });
    expect(selected).toEqual([
      {
        event: QUICK_FILTER_SELECTED,
        properties: {
          surface: 'agenda',
          quick_filter: 'weekend',
          results_count: 6,
          active_filter_count: 1,
        },
      },
    ]);
    expect(JSON.stringify(selected)).not.toContain('Fin de semana');

    const cleared = planAgendaAnalytics({
      reason: 'user',
      interaction: { kind: 'shortcut', shortcut: 'free' },
      previous: { access: 'free' },
      next: {},
      resultsBefore: 4,
      resultsCount: 40,
      now: NOW,
    });
    expect(cleared[0]).toMatchObject({
      event: FILTER_CLEARED,
      properties: { filter_key: 'free', results_before: 4, active_filter_count_before: 1 },
    });
  });

  it('un filtro manual usa el id y limpiar todo usa filter_key all', () => {
    const changed = planAgendaAnalytics({
      reason: 'user',
      interaction: { kind: 'submit' },
      previous: {},
      next: { format: 'opera' },
      resultsBefore: 40,
      resultsCount: 3,
      now: NOW,
    });
    expect(changed).toEqual([
      {
        event: FILTER_CHANGED,
        properties: {
          surface: 'agenda',
          filter_key: 'format',
          filter_value: 'opera',
          selected: true,
          results_count: 3,
          active_filter_count: 1,
        },
      },
    ]);

    const cleared = planAgendaAnalytics({
      reason: 'user',
      interaction: { kind: 'clear-all' },
      previous: { format: 'opera', q: 'bach' },
      next: {},
      resultsBefore: 3,
      resultsCount: 40,
      now: NOW,
    });
    expect(cleared).toEqual([
      {
        event: FILTER_CLEARED,
        properties: {
          surface: 'agenda',
          filter_key: 'all',
          results_before: 3,
          active_filter_count_before: 1,
        },
      },
    ]);
    expect(countActiveAgendaFilters({ format: 'opera', q: 'bach' }, NOW)).toBe(1);
  });
});

describe('búsqueda en vivo', () => {
  it('no emite en cada tecla y sí cuando la query se estabiliza, también con cero resultados', () => {
    let state = initialLiveSearchState();
    const start = 1_000;
    state = reduceLiveSearch(state, 'b', start);
    state = reduceLiveSearch(state, 'ba', start + 40);
    state = reduceLiveSearch(state, 'bach', start + 80);
    expect(flushLiveSearch(state, start + 200).query).toBeNull();
    const settled = flushLiveSearch(state, start + 80 + 400);
    expect(settled.query).toBe('bach');
    expect(flushLiveSearch(settled.state, start + 2_000).query).toBeNull();

    const { calls, capture } = recorder();
    trackSearchPerformed({ surface: 'venues', query: settled.query ?? '', results_count: 0 }, capture);
    expect(calls[0]?.properties).toEqual({ surface: 'venues', query: 'bach', results_count: 0 });

    state = reduceLiveSearch(initialLiveSearchState(), '', start);
    expect(state).toEqual(initialLiveSearchState());
    const again = reduceLiveSearch(state, 'bach', start + 10);
    expect(flushLiveSearch(again, start + 10 + 400).query).toBe('bach');
  });

  it('no agota la lista en las queries intermedias aunque ya haya resultados', () => {
    let state = initialLiveSearchState();
    const start = 5_000;
    const steps = [
      { query: 't', results: 12 },
      { query: 'te', results: 4 },
      { query: 'tea', results: 2 },
      { query: 'teat', results: 2 },
    ];
    const gate = new Set<string>();
    const published: string[] = [];

    const publishIfSettled = (results: number) => {
      const decision = venueResultsEndForSearch(state, results);
      if (!decision.enabled || !decision.observation) return;
      if (claimListExhaustion(gate, decision.observation)) published.push(decision.observation.stateKey);
    };

    publishIfSettled(40);
    expect(published).toEqual(['all']);

    for (const [index, step] of steps.entries()) {
      state = reduceLiveSearch(state, step.query, start + index * 40);
      expect(settledLiveSearchQuery(state)).toBeUndefined();
      publishIfSettled(step.results);
      expect(published).toEqual(['all']);
    }

    const flushed = flushLiveSearch(state, start + 3 * 40 + 400);
    state = flushed.state;
    expect(flushed.query).toBe('teat');
    expect(settledLiveSearchQuery(state)).toBe('teat');
    publishIfSettled(2);
    expect(published).toEqual(['all', 'teat']);
    expect(venueResultsEndForSearch(state, 2).observation).toMatchObject({
      surface: 'venues',
      results_count: 2,
      active_filter_count: 0,
      has_search_query: true,
      stateKey: 'teat',
    });

    state = reduceLiveSearch(state, '', start + 1_000);
    expect(state).toEqual(initialLiveSearchState());
    expect(settledLiveSearchQuery(state)).toBeNull();
    publishIfSettled(40);
    expect(published).toEqual(['all', 'teat']);
  });
});

describe('fichas', () => {
  const page = buildPageAnalytics('/eventos/carmen/', {
    page_type: 'event',
    event_id: 'evt_carmen',
    event_title: 'Carmen',
    venue_id: 'ven_real',
    venue_name: 'Teatro Real',
    access: 'free',
    is_free: true,
    format: 'opera',
    era: 'romantic',
    days_until_event: daysUntilEvent('2026-09-25', NOW),
  });

  it('abre una ficha una sola vez por documento', () => {
    const gate = new Set<string>();
    const { calls, capture } = recorder();
    publishEventOpened(page, '', PAGE, gate, capture);
    publishEventOpened(page, '', PAGE, gate, capture);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: EVENT_OPENED,
      properties: {
        event_id: 'evt_carmen',
        event_title: 'Carmen',
        venue_id: 'ven_real',
        origin: 'direct',
        access: 'free',
        is_free: true,
        format: 'opera',
        days_until_event: 3,
      },
    });
    expect(claimOnce(gate, 'event_opened:evt_carmen')).toBe(false);
  });

  it('el clic saliente no bloquea y guarda el dominio, no la URL', () => {
    const { calls, capture } = recorder();
    const tracked = () => {
      trackOutboundEventClick(
        {
          event_id: 'evt_carmen',
          event_title: 'Carmen',
          venue_id: 'ven_real',
          origin: 'agenda',
          access: 'paid',
          is_free: false,
          format: 'opera',
          destination_type: 'tickets',
          destination_domain: destinationDomain('https://www.teatroreal.es/es/entradas?token=secret&email=ada@example.com'),
        },
        capture,
      );
    };
    expect(onOutboundClick(tracked)).toBeUndefined();
    expect(onOutboundClick(() => { throw new Error('analytics down'); })).toBeUndefined();
    expect(calls).toEqual([
      {
        event: OUTBOUND_EVENT_CLICK,
        properties: {
          event_id: 'evt_carmen',
          event_title: 'Carmen',
          venue_id: 'ven_real',
          origin: 'agenda',
          access: 'paid',
          is_free: false,
          format: 'opera',
          destination_type: 'tickets',
          destination_domain: 'teatroreal.es',
        },
      },
    ]);
    expect(JSON.stringify(calls[0]?.properties)).not.toContain('secret');
    expect(JSON.stringify(calls[0]?.properties)).not.toContain('ada@');
  });

  it('no hace nada si PostHog no está', () => {
    expect(() => publishEventOpened(page, '', PAGE, new Set(), null)).not.toThrow();
    expect(() => trackSearchPerformed({ surface: 'agenda', query: 'bach', results_count: 1 }, null)).not.toThrow();
    expect(() => trackSearchPerformed({ surface: 'agenda', query: 'bach', results_count: 1 })).not.toThrow();
  });
});

describe('final de lista', () => {
  it('cuenta cada estado de resultados una vez y no cuenta una lista vacía', () => {
    const gate = new Set<string>();
    const base = {
      surface: 'agenda' as const,
      results_count: 4,
      active_filter_count: 0,
      has_search_query: false,
      stateKey: '',
    };
    expect(claimListExhaustion(gate, base)).toBe(true);
    expect(claimListExhaustion(gate, base)).toBe(false);
    expect(claimListExhaustion(gate, { ...base, stateKey: 'q=bach', has_search_query: true })).toBe(true);
    expect(claimListExhaustion(gate, { ...base, results_count: 0, stateKey: 'q=nada' })).toBe(false);

    const { calls, capture } = recorder();
    trackResultListExhausted(
      {
        surface: 'agenda',
        results_count: 4,
        active_filter_count: 1,
        has_search_query: true,
        quick_filter: 'free',
      },
      capture,
    );
    expect(calls[0]).toEqual({
      event: RESULT_LIST_EXHAUSTED,
      properties: {
        surface: 'agenda',
        results_count: 4,
        active_filter_count: 1,
        has_search_query: true,
        quick_filter: 'free',
      },
    });
    expect(calls[0]?.properties).not.toHaveProperty('stateKey');
  });

  it('las landings de atajo cuentan un filtro y el resto de listas estáticas ninguno', () => {
    expect(staticResultsObservation({ surface: 'agenda', resultsCount: 6, quickFilter: 'free' })).toMatchObject({
      surface: 'agenda',
      results_count: 6,
      active_filter_count: 1,
      has_search_query: false,
      quick_filter: 'free',
      stateKey: 'free',
    });
    expect(staticResultsObservation({ surface: 'agenda', resultsCount: 3, quickFilter: 'weekend' })).toMatchObject({
      quick_filter: 'weekend',
      active_filter_count: 1,
      stateKey: 'weekend',
    });
    expect(staticResultsObservation({ surface: 'agenda', resultsCount: 8 })).toMatchObject({
      active_filter_count: 0,
      quick_filter: undefined,
      stateKey: 'static',
    });
    expect(staticResultsObservation({ surface: 'venue', resultsCount: 2, quickFilter: 'gratis' })).toMatchObject({
      active_filter_count: 0,
      quick_filter: undefined,
      stateKey: 'static',
    });
    for (const quickFilter of ['free', 'weekend', 'gratis', 'fin-de-semana', 'opera', undefined]) {
      const observation = staticResultsObservation({ surface: 'agenda', resultsCount: 1, quickFilter });
      const shortcut = isAgendaShortcutId(quickFilter);
      expect(observation.active_filter_count).toBe(shortcut ? 1 : 0);
      expect(observation.quick_filter).toBe(shortcut ? quickFilter : undefined);
    }
  });

  it('no mete un div como hijo directo de ul u ol', () => {
    expect(resultsEndTag('ul')).toBe('li');
    expect(resultsEndTag('UL')).toBe('li');
    expect(resultsEndTag('ol')).toBe('li');
    expect(resultsEndTag('div')).toBe('div');
    expect(resultsEndTag('section')).toBe('div');

    const previousObserver = globalThis.IntersectionObserver;
    const previousDocument = globalThis.document;
    globalThis.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    globalThis.document = {
      createElement(tag: string) {
        return fakeResultsNode(tag);
      },
    } as unknown as Document;
    try {
      const observation = {
        surface: 'venues' as const,
        results_count: 2,
        active_filter_count: 0,
        has_search_query: false,
        stateKey: 'static',
      };
      for (const tag of ['ul', 'ol'] as const) {
        const list = fakeResultsNode(tag);
        syncResultsEnd(list as unknown as HTMLElement, { enabled: true, observation });
        expect(list.children.map((child) => child.tagName)).toEqual(['LI']);
        expect(list.children.some((child) => child.tagName === 'DIV')).toBe(false);
        const sentinel = list.children[0];
        expect(sentinel?.attributes.get('aria-hidden')).toBe('true');
        expect(sentinel?.style.height).toBe('1px');
        expect(sentinel?.style.border).toBe('0');
      }
      const panel = fakeResultsNode('div');
      syncResultsEnd(panel as unknown as HTMLElement, { enabled: true, observation });
      expect(panel.children.map((child) => child.tagName)).toEqual(['DIV']);
    } finally {
      globalThis.IntersectionObserver = previousObserver;
      globalThis.document = previousDocument;
    }
  });
});

describe('contacto y compartir', () => {
  it('contact_submitted solo sale tras el éxito y no incluye campos del formulario', () => {
    expect(CONTACT_TOPICS).toEqual(CONTACT_REASONS);
    const { calls, capture } = recorder();
    trackContactSubmitted(
      { topic: 'Corrección', email: 'ada@example.com', mensaje: 'hola', nombre: 'Ada' } as { topic: string },
      capture,
    );
    trackContactSubmitted({ topic: 'Publicidad' }, capture);
    expect(calls).toEqual([
      { event: CONTACT_SUBMITTED, properties: { surface: 'contact', topic: 'Corrección' } },
      { event: CONTACT_SUBMITTED, properties: { surface: 'contact' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain('ada@');
    expect(JSON.stringify(calls)).not.toContain('hola');
    expect(JSON.stringify(calls)).not.toContain('Ada');
  });

  it('share_clicked identifica el evento y el canal, sin el texto compartido', () => {
    const { calls, capture } = recorder();
    trackShareClicked(
      { event_id: 'evt_carmen', event_title: 'Carmen', channel: 'whatsapp', text: 'venid' } as {
        event_id: string;
        event_title: string;
        channel: 'whatsapp';
      },
      capture,
    );
    expect(calls).toEqual([
      {
        event: 'share_clicked',
        properties: { event_id: 'evt_carmen', event_title: 'Carmen', channel: 'whatsapp' },
      },
    ]);
  });
});

describe('canal de WhatsApp', () => {
  it('registra las dos ubicaciones con el tipo de página sin incluir la URL', () => {
    const { calls, capture } = recorder();
    trackWhatsAppChannelClicked({ placement: 'footer', page_type: 'agenda' }, capture);
    trackWhatsAppChannelClicked({ placement: 'about', page_type: 'about' }, capture);
    expect(calls).toEqual([
      { event: WHATSAPP_CHANNEL_CLICKED, properties: { placement: 'footer', page_type: 'agenda' } },
      { event: WHATSAPP_CHANNEL_CLICKED, properties: { placement: 'about', page_type: 'about' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain(WHATSAPP_CHANNEL_URL);
  });

  it('agenda_inline es una ubicación válida y no envía la URL del canal', () => {
    expect(WHATSAPP_CHANNEL_PLACEMENTS).toContain('agenda_inline');
    expect(isWhatsAppChannelPlacement('agenda_inline')).toBe(true);
    const { calls, capture } = recorder();
    trackWhatsAppChannelClicked({ placement: 'agenda_inline', page_type: 'agenda' }, capture);
    expect(calls).toEqual([
      {
        event: WHATSAPP_CHANNEL_CLICKED,
        properties: { placement: 'agenda_inline', page_type: 'agenda' },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(WHATSAPP_CHANNEL_URL);
    expect(JSON.stringify(calls)).not.toMatch(/after_10|agenda_after_10|position_10/);
  });

  it('no falla si PostHog no está disponible o si capture falla', () => {
    expect(() => trackWhatsAppChannelClicked({ placement: 'footer', page_type: 'event' }, null)).not.toThrow();
    expect(() => trackWhatsAppChannelClicked({ placement: 'about', page_type: 'about' }, () => {
      throw new Error('PostHog no disponible');
    })).not.toThrow();
  });
});

describe('cookieless', () => {
  it('no cambia la configuración de privacidad ni introduce identidad persistente', () => {
    expect(posthogInitConfig()).toMatchObject({
      cookieless_mode: 'always',
      person_profiles: 'never',
      capture_pageview: true,
      autocapture: false,
      disable_session_recording: true,
    });
    const source = stripComments(readAnalyticsSources());
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(source).not.toMatch(/posthog\.identify\s*\(/);
    expect(source).not.toMatch(/posthog\.alias\s*\(/);
    expect(source).not.toMatch(/\.register\s*\(/);
  });
});

type FakeResultsNode = {
  tagName: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attributes: Map<string, string>;
  children: FakeResultsNode[];
  setAttribute: (name: string, value: string) => void;
  append: (child: FakeResultsNode) => void;
  contains: (node: FakeResultsNode) => boolean;
  querySelector: (selector: string) => FakeResultsNode | null;
  getBoundingClientRect: () => { height: number; top: number; bottom: number };
  remove: () => void;
};

function fakeResultsNode(tag: string): FakeResultsNode {
  const node: FakeResultsNode = {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    attributes: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    append(child) {
      this.children.push(child);
    },
    contains(child) {
      return this.children.includes(child);
    },
    querySelector(selector) {
      if (selector !== ':scope > [data-results-end]') return null;
      return this.children.find((child) => Object.prototype.hasOwnProperty.call(child.dataset, 'resultsEnd')) ?? null;
    },
    getBoundingClientRect() {
      return { height: 0, top: 10_000, bottom: 10_000 };
    },
    remove() {},
  };
  return node;
}

function compileBeforeSend(pageJson: string | null) {
  const documentMock = {
    getElementById(id: string) {
      if (id !== 'analytics-page' || pageJson === null) return null;
      return { textContent: pageJson };
    },
  };
  const factory = new Function('document', `return (${pageviewBeforeSendSource()});`) as (
    document: typeof documentMock,
  ) => (event: { event?: string; properties?: Record<string, unknown> }) => {
    event?: string;
    properties?: Record<string, unknown>;
  };
  return factory(documentMock);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readAnalyticsSources(): string {
  const dir = join(process.cwd(), 'src/lib/analytics');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}
