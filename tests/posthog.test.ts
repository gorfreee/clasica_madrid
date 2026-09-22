import { describe, expect, it } from 'vitest';
import {
  captureContentShared,
  CONTENT_SHARED_EVENT,
  type ContentSharedProperties,
} from '../src/lib/analytics/capture.ts';
import {
  POSTHOG_API_HOST,
  POSTHOG_UI_HOST,
  posthogBootstrapScript,
  posthogInitConfig,
  readPosthogToken,
} from '../src/lib/analytics/posthog.ts';

const eventShare: ContentSharedProperties = {
  method: 'native_share',
  content_type: 'event',
  path: '/eventos/carmen/',
};

describe('token de PostHog', () => {
  it('trata ausencia y vacío como analytics desactivado', () => {
    expect(readPosthogToken(undefined)).toBeNull();
    expect(readPosthogToken(null)).toBeNull();
    expect(readPosthogToken('')).toBeNull();
    expect(readPosthogToken('   ')).toBeNull();
    for (const value of [undefined, null, '', '   '] as const) {
      const script = posthogBootstrapScript(value);
      expect(script).toBe('');
      expect(script).not.toContain('e.clasicamadrid.com');
      expect(script).not.toContain('array.js');
      expect(script).not.toContain('posthog');
    }
  });

  it('conserva un token presente, recortando espacios', () => {
    expect(readPosthogToken('  phc_example  ')).toBe('phc_example');
  });
});

describe('configuración cookieless', () => {
  it('pide analítica mínima en EU y deja apagado el resto', () => {
    expect(posthogInitConfig()).toEqual({
      api_host: 'https://e.clasicamadrid.com',
      ui_host: 'https://eu.posthog.com',
      defaults: '2026-05-30',
      cookieless_mode: 'always',
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      capture_dead_clicks: false,
      rageclick: false,
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
    });
    expect(posthogInitConfig().api_host).toBe('https://e.clasicamadrid.com');
    expect(posthogInitConfig().ui_host).toBe('https://eu.posthog.com');
    expect(posthogInitConfig().capture_pageview).toBe(true);
    expect(posthogInitConfig().capture_performance).toBe(false);
    expect(posthogInitConfig().disable_external_dependency_loading).toBe(true);
    expect(POSTHOG_API_HOST).toBe(posthogInitConfig().api_host);
    expect(POSTHOG_UI_HOST).toBe(posthogInitConfig().ui_host);
  });

  it('no inicializa dos veces ni llama a identify o alias', () => {
    const script = posthogBootstrapScript('phc_example');
    expect(script).toContain('if (!window.posthog || !window.posthog.__SV)');
    expect(script).toContain('p.async=!0');
    expect(script).toContain('"api_host":"https://e.clasicamadrid.com"');
    expect(script).toContain('"ui_host":"https://eu.posthog.com"');
    expect(script).not.toContain('eu.i.posthog.com');
    expect(script).not.toContain('eu-assets.i.posthog.com');
    expect(script).toContain('"cookieless_mode":"always"');
    expect(script).toContain('"person_profiles":"never"');
    expect(script).toContain('"advanced_disable_flags":true');
    expect(script).toContain('"capture_pageview":true');
    expect(script).toContain('"capture_performance":false');
    expect(script).toContain('"disable_external_dependency_loading":true');
    expect(script).toContain('__cmPosthogConfig.before_send=');
    expect(script).toContain('analytics-page');
    expect(script).not.toContain('history_change');
    expect(script).not.toMatch(/\.capture\(\s*["']\$pageview["']/);
    expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(script).not.toMatch(/posthog\.identify\s*\(/);
    expect(script).not.toMatch(/posthog\.alias\s*\(/);
    expect(script).toContain('posthog.init(');
    expect(() => new Function(script)).not.toThrow();
  });

  it('resuelve array.js en el reverse proxy sin reescribir el host', () => {
    const script = posthogBootstrapScript('phc_example');
    expect(script).toContain(
      's.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js"',
    );
    expect(POSTHOG_API_HOST.replace('.i.posthog.com', '-assets.i.posthog.com')).toBe(POSTHOG_API_HOST);
    expect(sdkUrlFromBootstrap(script)).toBe('https://e.clasicamadrid.com/static/array.js');
  });

  it('escapa un token que intentaría cerrar el script', () => {
    const script = posthogBootstrapScript('</script><script>alert(1)</script>');
    expect(script).not.toMatch(/<\/script>/i);
    expect(script).toContain('\\u003c');
    expect(script).toContain('alert(1)');
  });
});

describe('content_shared', () => {
  it('envía método, tipo y ruta, y nada más', () => {
    const calls: { event: string; properties: ContentSharedProperties }[] = [];
    captureContentShared(
      { method: 'whatsapp', content_type: 'venue', path: '/lugares/teatro-real/' },
      (event, properties) => calls.push({ event, properties }),
    );
    captureContentShared(
      { method: 'copy_link', content_type: 'event', path: '/eventos/carmen/' },
      (event, properties) => calls.push({ event, properties }),
    );

    expect(calls).toEqual([
      {
        event: CONTENT_SHARED_EVENT,
        properties: {
          method: 'whatsapp',
          content_type: 'venue',
          path: '/lugares/teatro-real/',
        },
      },
      {
        event: CONTENT_SHARED_EVENT,
        properties: {
          method: 'copy_link',
          content_type: 'event',
          path: '/eventos/carmen/',
        },
      },
    ]);
    expect(Object.keys(calls[0]!.properties)).toEqual(['method', 'content_type', 'path']);
  });

  it('no hace nada si PostHog no está y no propaga un fallo de captura', () => {
    expect(() => captureContentShared(eventShare)).not.toThrow();
    expect(() => captureContentShared(eventShare, null)).not.toThrow();
    expect(() =>
      captureContentShared(eventShare, () => {
        throw new Error('analytics down');
      }),
    ).not.toThrow();
  });
});

function sdkUrlFromBootstrap(script: string): string {
  const created: { src?: string }[] = [];
  const documentMock = {
    createElement() {
      return {};
    },
    getElementsByTagName() {
      return [
        {
          parentNode: {
            insertBefore(node: { src?: string }) {
              created.push(node);
              return node;
            },
          },
        },
      ];
    },
  };
  const globals = globalThis as typeof globalThis & {
    window?: unknown;
    document?: unknown;
    posthog?: unknown;
  };
  const previous = { window: globals.window, document: globals.document, posthog: globals.posthog };
  globals.window = globalThis;
  globals.document = documentMock;
  delete globals.posthog;
  try {
    new Function(script)();
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
    if (previous.posthog === undefined) delete globals.posthog;
    else globals.posthog = previous.posthog;
  }
  expect(created).toHaveLength(1);
  return created[0]?.src ?? '';
}
