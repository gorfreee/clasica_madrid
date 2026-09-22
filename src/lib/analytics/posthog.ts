import { serializeJsonForScript } from '../util/json-script.ts';
import { pageviewBeforeSendSource } from './page.ts';

/** Ingestión y assets del Managed Reverse Proxy. La UI sigue en `POSTHOG_UI_HOST`. */
export const POSTHOG_API_HOST = 'https://e.clasicamadrid.com';
export const POSTHOG_UI_HOST = 'https://eu.posthog.com';

/**
 * Cargador oficial de array.js. `init` crea el script asíncrono; definir el
 * stub no descarga el SDK. La lista de métodos es la cola documentada, no
 * llamadas que haga este sitio.
 *
 * Si `api_host` no contiene `.i.posthog.com`, el `replace` del snippet no
 * cambia el host y el SDK se pide en `{api_host}/static/array.js`.
 */
const POSTHOG_SNIPPET =
  '!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);';

export type PosthogInitConfig = {
  api_host: typeof POSTHOG_API_HOST;
  ui_host: typeof POSTHOG_UI_HOST;
  defaults: '2026-05-30';
  cookieless_mode: 'always';
  person_profiles: 'never';
  autocapture: false;
  capture_pageview: true;
  capture_pageleave: true;
  disable_session_recording: true;
  disable_surveys: true;
  disable_web_experiments: true;
  capture_heatmaps: false;
  capture_performance: false;
  capture_exceptions: false;
  capture_dead_clicks: false;
  rageclick: false;
  advanced_disable_flags: true;
  disable_external_dependency_loading: true;
};

/**
 * Analítica mínima de PostHog Cloud EU, sin cookies, para un sitio multipágina.
 * El navegador habla con `POSTHOG_API_HOST`; `ui_host` sigue en PostHog EU.
 *
 * `defaults: '2026-05-30'` dejaría `capture_pageview` en `history_change`.
 * El booleano `true` mantiene un pageview por carga: los filtros de la agenda
 * hacen `pushState` de la query y la navegación normal ya recarga el documento.
 * `capture_pageleave` sigue activo para que Web Analytics pueda medir sesiones.
 * `advanced_disable_flags` omite `/flags` porque no usamos flags, encuestas ni
 * configuración remota. `cookieless_mode: 'always'` es lo que impide cookies,
 * localStorage y sessionStorage; no hace falta cambiar `persistence` a `memory`.
 *
 * El bootstrap añade `before_send` aparte de este objeto: copia el contexto de
 * `#analytics-page` solo en `$pageview` y `$pageleave`. No registra super
 * properties ni dispara un segundo pageview.
 */
export function posthogInitConfig(): PosthogInitConfig {
  return {
    api_host: POSTHOG_API_HOST,
    ui_host: POSTHOG_UI_HOST,
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
  };
}

/** Un token ausente o vacío deja la analítica apagada. No es un secreto, pero no se versiona. */
export function readPosthogToken(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

/**
 * Bootstrap inline, o `''` si la analítica está apagada. El token y la
 * configuración se escapan como JSON para que un valor hostil no cierre el script.
 */
export function posthogBootstrapScript(value: string | undefined | null): string {
  const token = readPosthogToken(value);
  if (!token) return '';
  return `if (!window.posthog || !window.posthog.__SV) {${POSTHOG_SNIPPET}var __cmPosthogConfig=${serializeJsonForScript(posthogInitConfig())};__cmPosthogConfig.before_send=${pageviewBeforeSendSource()};posthog.init(${serializeJsonForScript(token)}, __cmPosthogConfig);}`;
}
