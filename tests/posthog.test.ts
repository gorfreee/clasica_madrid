import { describe, expect, it } from 'vitest';
import {
  captureContentShared,
  CONTENT_SHARED_EVENT,
  type ContentSharedProperties,
} from '../src/lib/analytics/capture.ts';
import {
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
    expect(posthogBootstrapScript(undefined)).toBe('');
    expect(posthogBootstrapScript('')).toBe('');
    expect(posthogBootstrapScript('   ')).toBe('');
  });

  it('conserva un token presente, recortando espacios', () => {
    expect(readPosthogToken('  phc_example  ')).toBe('phc_example');
  });
});

describe('configuración cookieless', () => {
  it('pide analítica mínima en EU y deja apagado el resto', () => {
    expect(posthogInitConfig()).toEqual({
      api_host: 'https://eu.i.posthog.com',
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
    expect(posthogInitConfig().capture_pageview).toBe(true);
  });

  it('no inicializa dos veces ni llama a identify o alias', () => {
    const script = posthogBootstrapScript('phc_example');
    expect(script).toContain('if (!window.posthog || !window.posthog.__SV)');
    expect(script).toContain('p.async=!0');
    expect(script).toContain('https://eu.i.posthog.com');
    expect(script).toContain('"cookieless_mode":"always"');
    expect(script).toContain('"person_profiles":"never"');
    expect(script).toContain('"advanced_disable_flags":true');
    expect(script).toContain('"capture_pageview":true');
    expect(script).not.toContain('history_change');
    expect(script).not.toMatch(/posthog\.identify\s*\(/);
    expect(script).not.toMatch(/posthog\.alias\s*\(/);
    expect(script).toContain('posthog.init(');
    expect(() => new Function(script)).not.toThrow();
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
