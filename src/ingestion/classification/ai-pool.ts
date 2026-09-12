import { randomUUID } from 'node:crypto';
import type { ObservedFacts } from '../observed.ts';
import {
  AI_CLASSIFY_TIMEOUT_MS,
  AiRateLimitedError,
  AiUnusableOutputError,
  failureKindForUnusable,
  failureKindForTransport,
  parseAiOutputForPurpose,
  parseAiTaxonomy,
  sanitizeAiOutputExcerpt,
  taxonomyFormatsStillUnresolved,
  type AiAttemptFailure,
  type AiCallContext,
  type AiCallDiagnostics,
  type AiCallPurpose,
  type AiClassifier,
  type AiFailureKind,
  type AiProviderStats,
  type AiRouteRuntimeStats,
} from './ai.ts';
import { buildAiRequest, type AiRequest } from './ai-request.ts';
import { AiPoolState, hashAiInput } from './ai-state.ts';
import { AiTransportError, primaryPressure, type AiPressureKind, type AiRoute } from './ai-transport.ts';
import { observedFormatChoiceIsUnresolved } from './format-alternatives.ts';

export const AI_POOL_MAX_RETRIES = 2;
export const AI_POOL_BACKOFF_BASE_MS = 2_000;
export const AI_POOL_MAX_RETRY_WAIT_MS = 60_000;
export const AI_POOL_CLASSIFY_BUDGET_MS = 180_000;
export const AI_POOL_DEFAULT_CONCURRENCY = 8;
/** Consecutive unhealthy outcomes without a valid result that open a route circuit. */
export const AI_POOL_CIRCUIT_FAILURE_THRESHOLD = 4;
const CIRCUIT_UNHEALTHY = new Set<AiFailureKind>([
  'empty-output',
  'incomplete',
  'malformed-output',
  'invalid-output',
  'timeout',
  'bad-request',
  'transport-error',
]);
const INTEGER_LIMITS = [
  'maxConcurrent',
  'minIntervalMs',
  'providerMaxConcurrent',
  'providerMinIntervalMs',
] as const;
const DISABLE_LIMITS = [
  'rpm',
  'tpm',
  'rpd',
  'maxConcurrent',
  'providerMaxConcurrent',
] as const;

export type SleepClock = { now(): number; sleep(ms: number): Promise<void> };
export type AiPoolClassifierOptions = {
  routes: AiRoute[];
  maxRetries?: number;
  timeoutMs?: number;
  classifyBudgetMs?: number;
  concurrency?: number;
  maxRequests?: number;
  stateDir?: string;
  cacheEnabled?: boolean;
  clock?: SleepClock;
  random?: () => number;
};

type Reservation = { route: AiRoute; id: string; estimated: number };
type CallResult = { value: unknown; diagnostics: AiCallDiagnostics };
type RouteHealth = {
  consecutiveUnhealthy: number;
  lastUnhealthyKind?: AiFailureKind;
  circuitOpen: boolean;
  circuitReason?: string;
  failuresByKind: Partial<Record<AiFailureKind, number>>;
  rateLimits: number;
  quotaExhausted: number;
  concurrencyPressure: number;
  pressureByKind: Partial<Record<AiPressureKind, number>>;
};

const systemClock: SleepClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Provider-neutral ordered-route scheduler. Editorial validation stays outside transports. */
export class AiPoolClassifier implements AiClassifier {
  readonly routes: readonly AiRoute[];
  readonly classifyBudgetMs: number;
  readonly concurrency: number;
  private readonly options: AiPoolClassifierOptions;
  private readonly clock: SleepClock;
  private readonly state: AiPoolState;
  private readonly disabledRoutes = new Map<string, Error>();
  private readonly fatalProviders = new Map<string, Error>();
  private readonly inFlight = new Map<string, Promise<CallResult>>();
  private readonly health = new Map<string, RouteHealth>();
  private readonly inFlightByRoute = new Map<string, number>();
  private readonly inFlightByProvider = new Map<string, number>();
  private readonly lastStartByRoute = new Map<string, number>();
  private readonly lastStartByProvider = new Map<string, number>();
  /** Run-local cap after an explicit concurrency-pressure signal. Never persisted. */
  private readonly runtimeProviderMaxConcurrent = new Map<string, number>();
  private reservationTail = Promise.resolve();
  private active = 0;
  private reservedRequests = 0;
  private lastCall?: AiCallDiagnostics;
  private readonly stats = {
    httpRequests: 0,
    retries: 0,
    modelFallbacks: 0,
    logicalCalls: 0,
    sameRouteRetries: 0,
    httpFallbacks: 0,
    fallbackCalls: 0,
    circuitOpenRoutes: 0,
    cacheHits: 0,
    deferred: 0,
    requestsByRoute: {} as Record<string, number>,
    classificationsByRoute: {} as Record<string, number>,
    inputTokensByRoute: {} as Record<string, number>,
    outputTokensByRoute: {} as Record<string, number>,
    thoughtTokensByRoute: {} as Record<string, number>,
    requestsByProvider: {} as Record<string, number>,
    classificationsByProvider: {} as Record<string, number>,
    requestsByPurpose: {} as Partial<Record<AiCallPurpose, number>>,
    failuresByKind: {} as Partial<Record<AiAttemptFailure['kind'], number>>,
    rateLimitsByRoute: {} as Record<string, number>,
    rateLimitsByProvider: {} as Record<string, number>,
    rateLimits: 0,
    quotaExhausted: 0,
    concurrencyPressure: 0,
    pressureByKind: {} as Partial<Record<AiPressureKind, number>>,
    concurrencyPressureByProvider: {} as Record<string, number>,
    concurrencyPressureByRoute: {} as Record<string, number>,
  };

  constructor(options: AiPoolClassifierOptions) {
    if (options.routes.length === 0) throw new Error('IA: el pool necesita al menos una route');
    const seen = new Set<string>();
    for (const route of options.routes) {
      if (route.routeId !== `${route.provider}:${route.model}`) throw new Error(`IA: routeId inválido: ${route.routeId}`);
      if (seen.has(route.routeId)) throw new Error(`IA: route duplicada: ${route.routeId}`);
      if (route.transport.provider !== route.provider) throw new Error(`IA: transport incorrecto para ${route.routeId}`);
      seen.add(route.routeId);
      for (const [name, limit] of Object.entries(route.limits ?? {})) {
        if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
          throw new Error(`IA: límite ${name} inválido para ${route.routeId}`);
        }
      }
      for (const name of INTEGER_LIMITS) {
        const value = route.limits?.[name];
        if (value !== undefined && !Number.isSafeInteger(value)) {
          throw new Error(`IA: límite ${name} inválido para ${route.routeId}`);
        }
      }
      if (route.limits?.rpd !== undefined && route.limits.rpd > 0 && !route.reset) {
        throw new Error(`IA: ${route.routeId} declara RPD sin política de reset`);
      }
    }
    this.routes = [...options.routes];
    this.options = options;
    this.classifyBudgetMs = options.classifyBudgetMs ?? AI_POOL_CLASSIFY_BUDGET_MS;
    this.concurrency = options.concurrency ?? AI_POOL_DEFAULT_CONCURRENCY;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16) {
      throw new Error('IA: concurrency debe estar entre 1 y 16');
    }
    for (const [name, value] of Object.entries({
      maxRetries: options.maxRetries ?? AI_POOL_MAX_RETRIES,
      maxRequests: options.maxRequests ?? Number.MAX_SAFE_INTEGER,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`IA: ${name} inválido`);
    }
    for (const value of [this.classifyBudgetMs, options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('IA: timeout inválido');
    }
    this.clock = options.clock ?? systemClock;
    this.state = new AiPoolState(options.stateDir);
  }

  initialize(): void { this.state.initialize(); }
  close(): void { this.state.close(); }
  lastDiagnostics(): AiCallDiagnostics | undefined { return this.lastCall ? structuredClone(this.lastCall) : undefined; }

  snapshotStats(): AiProviderStats {
    const requestsByRoute = structuredClone(this.stats.requestsByRoute);
    const classificationsByRoute = structuredClone(this.stats.classificationsByRoute);
    const inputTokensByRoute = structuredClone(this.stats.inputTokensByRoute);
    const dailyRequestsByRoute = this.state.dailyCounts(this.clock.now(), this.routes);
    return {
      httpRequests: this.stats.httpRequests,
      retries: this.stats.retries,
      modelFallbacks: this.stats.httpFallbacks,
      logicalCalls: this.stats.logicalCalls,
      sameRouteRetries: this.stats.sameRouteRetries,
      httpFallbacks: this.stats.httpFallbacks,
      fallbackCalls: this.stats.fallbackCalls,
      circuitOpenRoutes: this.stats.circuitOpenRoutes,
      cacheHits: this.stats.cacheHits,
      deferred: this.stats.deferred,
      requestsByRoute,
      classificationsByRoute,
      inputTokensByRoute,
      dailyRequestsByRoute,
      outputTokensByRoute: structuredClone(this.stats.outputTokensByRoute),
      thoughtTokensByRoute: structuredClone(this.stats.thoughtTokensByRoute),
      requestsByProvider: structuredClone(this.stats.requestsByProvider),
      classificationsByProvider: structuredClone(this.stats.classificationsByProvider),
      requestsByPurpose: structuredClone(this.stats.requestsByPurpose),
      failuresByKind: structuredClone(this.stats.failuresByKind),
      rateLimitsByRoute: structuredClone(this.stats.rateLimitsByRoute),
      rateLimitsByProvider: structuredClone(this.stats.rateLimitsByProvider),
      rateLimits: this.stats.rateLimits,
      quotaExhausted: this.stats.quotaExhausted,
      concurrencyPressure: this.stats.concurrencyPressure,
      pressureByKind: structuredClone(this.stats.pressureByKind),
      concurrencyPressureByProvider: structuredClone(this.stats.concurrencyPressureByProvider),
      concurrencyPressureByRoute: structuredClone(this.stats.concurrencyPressureByRoute),
      routes: this.routeSnapshots(),
      requestsByModel: requestsByRoute,
      classificationsByModel: classificationsByRoute,
      inputTokensByModel: inputTokensByRoute,
      dailyRequestsByModel: dailyRequestsByRoute,
    };
  }

  async classify(observed: ObservedFacts, context: AiCallContext = {}): Promise<unknown> {
    this.initialize();
    const purpose: AiCallPurpose = context.purpose ?? 'eligibility';
    const requireFormats = Boolean(context.requireFormats);
    const request = buildAiRequest(observed, purpose);
    const acceptEmptyFormats = acceptEmptyTaxonomyFormats(purpose, requireFormats, observed);
    const requestKey = hashAiInput({ purpose, request, observed, requireFormats, acceptEmptyFormats });
    const flightKey = hashAiInput({
      requestKey,
      routes: this.routes.map((route) => ({
        routeId: route.routeId,
        transport: route.transport.cacheIdentity(route.model),
      })),
    });
    const diagnostics: AiCallDiagnostics = {
      attempts: 0,
      fallbackUsed: false,
      cacheHit: false,
      routing: [],
      failures: [],
      purpose,
    };
    const publishDiagnostics = () => {
      this.lastCall = structuredClone(diagnostics);
      context.onDiagnostics?.(structuredClone(diagnostics));
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.classifyBudgetMs);
    let flight: Promise<CallResult> | undefined;
    try {
      controller.signal.throwIfAborted();
      const existing = this.options.cacheEnabled !== false ? this.inFlight.get(flightKey) : undefined;
      if (existing) {
        const result = await abortable(existing, controller.signal);
        Object.assign(diagnostics, result.diagnostics, {
          attempts: 0,
          cacheHit: true,
          routing: [routingEntry(this.routeForDiagnostics(result.diagnostics), 'in-flight-cache')],
        });
        this.stats.cacheHits++;
        return structuredClone(result.value);
      }
      flight = this.classifyOnce(
        request, requestKey, diagnostics, controller.signal, requireFormats, acceptEmptyFormats,
      );
      if (this.options.cacheEnabled !== false) this.inFlight.set(flightKey, flight);
      return (await flight).value;
    } catch (error) {
      diagnostics.deferred = true;
      this.stats.deferred++;
      const reason = this.redactError(error);
      this.state.defer(requestKey, observed, request, diagnostics, reason);
      if (controller.signal.aborted) throw new Error('tiempo agotado en la clasificación con IA');
      if (error instanceof Error && error.message !== reason) error.message = reason;
      throw error;
    } finally {
      if (flight && this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      publishDiagnostics();
    }
  }

  private async classifyOnce(
    request: AiRequest,
    requestKey: string,
    diagnostics: AiCallDiagnostics,
    signal: AbortSignal,
    requireFormats: boolean,
    acceptEmptyFormats: boolean,
  ): Promise<CallResult> {
    const deadline = this.clock.now() + this.classifyBudgetMs;
    const maxAttempts = 1 + (this.options.maxRetries ?? AI_POOL_MAX_RETRIES);
    const skippedThisCall = new Set<string>();
    let lastError: unknown;
    let firstHttpRouteId: string | undefined;
    let countedFallbackCall = false;
    this.stats.logicalCalls++;

    while (diagnostics.attempts! < maxAttempts) {
      signal.throwIfAborted();
      if (this.options.cacheEnabled !== false) {
        for (const route of this.routes) {
          if (!this.enabled(route) || skippedThisCall.has(route.routeId)) continue;
          const value = this.state.cached(this.cacheKey(requestKey, route), request.purpose);
          if (value === undefined || isUnsatisfactoryTaxonomyFormats(request.purpose, requireFormats, value, acceptEmptyFormats)) continue;
          this.selectDiagnostics(diagnostics, route, 'cache');
          diagnostics.cacheHit = true;
          this.stats.cacheHits++;
          this.state.resolvePending(requestKey);
          return { value, diagnostics };
        }
      }

      const { route, id, estimated } = await this.acquire(
        request, deadline, signal, diagnostics, skippedThisCall, lastError,
      );
      if (diagnostics.attempts! > 0) {
        this.stats.retries++;
        if (firstHttpRouteId === route.routeId) this.stats.sameRouteRetries++;
        else {
          this.stats.httpFallbacks++;
          if (!countedFallbackCall) {
            this.stats.fallbackCalls++;
            countedFallbackCall = true;
          }
          diagnostics.fallbackUsed = true;
        }
      }
      firstHttpRouteId ??= route.routeId;
      diagnostics.attempts!++;
      this.selectDiagnostics(diagnostics, route);
      this.stats.httpRequests++;
      bump(this.stats.requestsByRoute, route.routeId);
      bump(this.stats.requestsByProvider, route.provider);
      bump(this.stats.requestsByPurpose as Record<string, number>, request.purpose);
      try {
        const result = await route.transport.request({
          model: route.model,
          request,
          signal,
          timeoutMs: this.options.timeoutMs ?? AI_CLASSIFY_TIMEOUT_MS,
        });
        const state = this.state.route(route.routeId, this.clock.now(), route.reset);
        if (result.tokens?.input !== undefined) {
          const recent = state.recent.find((item) => item.id === id);
          if (recent) recent.tokens = result.tokens.input;
          state.tokenScale = Math.max(state.tokenScale, result.tokens.input / estimated * state.tokenScale);
          bump(this.stats.inputTokensByRoute, route.routeId, result.tokens.input);
          this.state.save();
        }
        if (result.tokens?.output !== undefined) bump(this.stats.outputTokensByRoute, route.routeId, result.tokens.output);
        if (result.tokens?.thought !== undefined) bump(this.stats.thoughtTokensByRoute, route.routeId, result.tokens.thought);
        if (result.rateLimit?.remainingRequests === 0 && result.rateLimit.resetAfterMs !== undefined) {
          state.cooldownUntil = Math.max(state.cooldownUntil, this.clock.now() + result.rateLimit.resetAfterMs);
          this.state.save();
        }
        diagnostics.status = result.status;
        diagnostics.tokens = result.tokens;
        const parsed = parseAiOutputForPurpose(request.purpose, result.value);
        if (!parsed.ok) {
          throw new AiUnusableOutputError(`IA: output no cumple el schema (${parsed.reason})`, {
            kind: parsed.ruleId === 'ai-invalid-output' ? 'invalid' : 'malformed',
            model: route.model,
            status: result.status,
            finishReason: result.finishReason,
            tokens: result.tokens,
            excerpt: sanitizeAiOutputExcerpt(typeof result.value === 'string' ? result.value : JSON.stringify(result.value)),
          });
        }
        const unresolvedFormats = isUnsatisfactoryTaxonomyFormats(
          request.purpose, requireFormats, result.value, acceptEmptyFormats,
        );
        if (unresolvedFormats && diagnostics.attempts! < maxAttempts) {
          throw new AiUnusableOutputError('IA: formats vacío no resuelve la taxonomía', {
            kind: 'incomplete', model: route.model, status: result.status,
            finishReason: result.finishReason, tokens: result.tokens,
            excerpt: sanitizeAiOutputExcerpt(typeof result.value === 'string' ? result.value : JSON.stringify(result.value)),
          });
        }
        if (!unresolvedFormats && this.options.cacheEnabled !== false) {
          this.state.cache(this.cacheKey(requestKey, route), request.purpose, result.value);
        }
        this.state.resolvePending(requestKey);
        this.noteSuccess(route);
        bump(this.stats.classificationsByRoute, route.routeId);
        bump(this.stats.classificationsByProvider, route.provider);
        return { value: result.value, diagnostics };
      } catch (error) {
        lastError = error;
        signal.throwIfAborted();
        this.handleAttemptError(error, route, diagnostics, skippedThisCall);
      } finally {
        this.release(route);
      }
    }
    throw lastError
      ? this.finalizeLastError(lastError, diagnostics)
      : new Error('IA: máximo de intentos alcanzado');
  }

  private handleAttemptError(
    error: unknown,
    route: AiRoute,
    diagnostics: AiCallDiagnostics,
    skippedThisCall: Set<string>,
  ): void {
    if (error instanceof AiUnusableOutputError) {
      bump(this.stats.failuresByKind as Record<string, number>, failureKindForUnusable(error.kind));
      diagnostics.status = error.status ?? error.kind;
      diagnostics.tokens = error.tokens;
      pushFailure(diagnostics, route, {
        model: route.model,
        kind: failureKindForUnusable(error.kind),
        status: error.status,
        finishReason: error.finishReason,
        tokens: error.tokens,
        excerpt: error.excerpt,
      });
      skipRouteWhenAlternativeExists(
        skippedThisCall,
        route,
        this.routes,
        (candidate) => this.available(candidate, skippedThisCall),
      );
      addRoute(diagnostics, route, failureKindForUnusable(error.kind));
      this.noteAttemptOutcome(route, failureKindForUnusable(error.kind));
      return;
    }
    if (!(error instanceof AiTransportError)) throw error;

    diagnostics.status = error.status === undefined ? error.kind : String(error.status);

    const state = this.state.route(route.routeId, this.clock.now(), route.reset);
    if (error.kind === 'rate-limit') {
      const pressure = error.pressure ?? primaryPressure(error.rateLimit?.dimensions);
      const failureKind: AiFailureKind = pressure === 'concurrency' ? 'concurrency-pressure' : 'rate-limit';
      if (failureKind === 'concurrency-pressure') {
        this.stats.concurrencyPressure++;
        bump(this.stats.concurrencyPressureByRoute, route.routeId);
        bump(this.stats.concurrencyPressureByProvider, route.provider);
        this.tightenProviderConcurrency(route.provider);
      } else {
        this.stats.rateLimits++;
        bump(this.stats.rateLimitsByRoute, route.routeId);
        bump(this.stats.rateLimitsByProvider, route.provider);
      }
      if (pressure) bump(this.stats.pressureByKind as Record<string, number>, pressure);
      if (error.quotaExhausted) {
        this.stats.quotaExhausted++;
        this.routeHealth(route.routeId).quotaExhausted++;
      }
      if (error.quotaExhausted && route.reset) state.dailyUntil = route.reset.nextReset(this.clock.now());
      else state.cooldownUntil = Math.max(
        state.cooldownUntil,
        this.clock.now() + this.retryWait(error, diagnostics.attempts! - 1),
      );
      this.state.save();
      if (pressure === 'capacity') {
        // Provider busy is transient capacity, not a quota we must wait out.
        // Skip this route for the rest of the call so the pool can try another
        // route immediately instead of sleeping on Retry-After.
        skipRouteWhenAlternativeExists(
          skippedThisCall,
          route,
          this.routes,
          (candidate) => this.available(candidate, skippedThisCall),
        );
      }
      addRoute(
        diagnostics,
        route,
        error.quotaExhausted ? 'daily-quota' : failureKind === 'concurrency-pressure' ? 'concurrency-pressure' : pressureReason(pressure),
      );
      pushFailure(diagnostics, route, {
        model: route.model,
        kind: failureKind,
        status: error.status === undefined ? undefined : String(error.status),
        ...(error.code ? { code: error.code } : {}),
        retryable: error.retryable,
        excerpt: sanitizeAiOutputExcerpt(this.redactForRoute(route, error.message)),
        ...(pressure ? { pressure } : {}),
        ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}),
      });
      bump(this.stats.failuresByKind as Record<string, number>, failureKind);
      this.noteAttemptOutcome(route, failureKind, pressure);
      return;
    } else if (error.kind === 'unavailable') {
      this.disabledRoutes.set(route.routeId, error);
      addRoute(diagnostics, route, 'unavailable-model-or-config');
    } else if (error.kind === 'auth') {
      this.fatalProviders.set(route.provider, error);
      addRoute(diagnostics, route, 'fatal-auth');
    } else {
      state.cooldownUntil = this.clock.now() + this.retryWait(undefined, diagnostics.attempts! - 1);
      this.state.save();
      addRoute(diagnostics, route, error.kind);
      skipRouteWhenAlternativeExists(
        skippedThisCall,
        route,
        this.routes,
        (candidate) => this.available(candidate, skippedThisCall),
      );
    }
    const failureKind = failureKindForTransport(error.kind, error.pressure);
    pushFailure(diagnostics, route, {
      model: route.model,
      kind: failureKind,
      status: error.status === undefined ? undefined : String(error.status),
      ...(error.code ? { code: error.code } : {}),
      retryable: error.retryable,
      excerpt: sanitizeAiOutputExcerpt(this.redactForRoute(route, error.message)),
    });
    bump(this.stats.failuresByKind as Record<string, number>, failureKind);
    this.noteAttemptOutcome(route, failureKind);
  }

  private async acquire(
    request: AiRequest,
    deadline: number,
    signal: AbortSignal,
    diagnostics: AiCallDiagnostics,
    skippedThisCall: ReadonlySet<string>,
    lastError: unknown,
  ): Promise<Reservation> {
    while (true) {
      signal.throwIfAborted();
      const decision = await this.withReservationLock(() => this.tryReserve(
        request, deadline, diagnostics, skippedThisCall, lastError,
      ));
      if (decision.kind === 'reserved') return decision.reservation;
      if (decision.kind === 'fail') throw decision.error;
      await sleep(this.clock, decision.wait, signal);
    }
  }

  /**
   * Check-and-reserve must be atomic: concurrent classify() waiters can otherwise
   * all wake from minInterval/cooldown sleep and skip the same route interval.
   */
  private withReservationLock<T>(work: () => T): Promise<T> {
    const run = this.reservationTail.then(work, work);
    this.reservationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private tryReserve(
    request: AiRequest,
    deadline: number,
    diagnostics: AiCallDiagnostics,
    skippedThisCall: ReadonlySet<string>,
    lastError: unknown,
  ): { kind: 'reserved'; reservation: Reservation } | { kind: 'wait'; wait: number } | { kind: 'fail'; error: Error } {
    if (this.reservedRequests >= (this.options.maxRequests ?? Number.MAX_SAFE_INTEGER)) {
      return { kind: 'fail', error: new AiRateLimitedError('IA: presupuesto HTTP global de esta ejecución agotado') };
    }
    const now = this.clock.now();
    if (now >= deadline) {
      return { kind: 'fail', error: this.deadlineWaitError(lastError, diagnostics) };
    }
    let earliest = Infinity;
    let hasPotentialRoute = false;
    for (const route of this.routes) {
      if (!this.available(route, skippedThisCall)) {
        const reason = skippedThisCall.has(route.routeId)
          ? 'unusable-output'
          : this.fatalProviders.has(route.provider)
            ? 'fatal-provider'
            : this.routeHealth(route.routeId).circuitOpen
              ? 'circuit-open'
              : 'disabled';
        addRoute(diagnostics, route, reason);
        continue;
      }
      hasPotentialRoute = true;
      const state = this.state.route(route.routeId, now, route.reset);
      const rpd = route.limits?.rpd ?? Infinity;
      if (state.requests >= rpd || state.dailyUntil > now) {
        addRoute(diagnostics, route, state.dailyUntil > now ? 'daily-quota' : 'daily-budget');
        continue;
      }
      const estimated = Math.ceil(this.estimateInputTokens(request, route) * state.tokenScale);
      const tpm = route.limits?.tpm ?? Infinity;
      if (estimated > tpm) {
        addRoute(diagnostics, route, 'input-over-tpm');
        continue;
      }
      if (this.atConcurrencyCap(this.inFlightByRoute, route.routeId, route.limits?.maxConcurrent)) {
        addRoute(diagnostics, route, 'route-concurrency');
        earliest = Math.min(earliest, now + 25);
        continue;
      }
      const providerConcurrent = this.effectiveProviderMaxConcurrent(route.provider);
      if (this.atConcurrencyCap(this.inFlightByProvider, route.provider, providerConcurrent)) {
        addRoute(diagnostics, route, 'provider-concurrency');
        earliest = Math.min(earliest, now + 25);
        continue;
      }
      if (state.nextAt > now) addRoute(diagnostics, route, 'rpm-wait');
      if (state.cooldownUntil > now) addRoute(diagnostics, route, 'cooldown');
      let next = Math.max(now, state.nextAt, state.cooldownUntil);
      const routeInterval = route.limits?.minIntervalMs ?? 0;
      const routeReadyAt = (this.lastStartByRoute.get(route.routeId) ?? 0) + routeInterval;
      if (routeReadyAt > now) addRoute(diagnostics, route, 'route-min-interval');
      next = Math.max(next, routeReadyAt);
      const providerInterval = this.providerCap(route.provider, 'providerMinIntervalMs') ?? 0;
      const providerReadyAt = (this.lastStartByProvider.get(route.provider) ?? 0) + providerInterval;
      if (providerReadyAt > now) addRoute(diagnostics, route, 'provider-min-interval');
      next = Math.max(next, providerReadyAt);
      let tokens = state.recent.reduce((sum, item) => sum + item.tokens, 0);
      if (tokens + estimated > tpm) addRoute(diagnostics, route, 'tpm-wait');
      for (const item of state.recent) {
        if (tokens + estimated <= tpm) break;
        tokens -= item.tokens;
        next = Math.max(next, item.at + 60_000);
      }
      if (next <= now && this.active < this.concurrency) {
        const id = randomUUID();
        state.requests++;
        state.nextAt = now + Math.max(
          intervalMsForRpm(route.limits?.rpm),
          route.limits?.minIntervalMs ?? 0,
        );
        state.recent.push({ id, at: now, tokens: estimated });
        this.state.save();
        this.reservedRequests++;
        this.active++;
        bumpMap(this.inFlightByRoute, route.routeId);
        bumpMap(this.inFlightByProvider, route.provider);
        this.lastStartByRoute.set(route.routeId, now);
        this.lastStartByProvider.set(route.provider, now);
        addRoute(
          diagnostics,
          route,
          route.routeId === this.routes[0]!.routeId ? 'preferred-ready' : 'next-available',
        );
        return { kind: 'reserved', reservation: { route, id, estimated } };
      }
      earliest = Math.min(earliest, next);
    }
    if (!Number.isFinite(earliest)) {
      const fatal = this.routes.map((route) => this.fatalProviders.get(route.provider)).find(Boolean);
      if (!hasPotentialRoute && fatal) {
        return { kind: 'fail', error: this.finalizeLastError(fatal, diagnostics) };
      }
      return { kind: 'fail', error: this.noUsableRouteError(lastError, diagnostics) };
    }
    if (earliest >= deadline) {
      return { kind: 'fail', error: this.nextAvailabilityError(lastError, diagnostics) };
    }
    return { kind: 'wait', wait: Math.min(1_000, Math.max(25, earliest - now), deadline - now) };
  }

  private enabled(route: AiRoute): boolean {
    const limits = route.limits ?? {};
    return DISABLE_LIMITS.every((name) => limits[name] !== 0);
  }

  private available(route: AiRoute, skipped: ReadonlySet<string>): boolean {
    return this.enabled(route)
      && !this.disabledRoutes.has(route.routeId)
      && !this.fatalProviders.has(route.provider)
      && !skipped.has(route.routeId)
      && !this.routeHealth(route.routeId).circuitOpen;
  }

  private release(route: AiRoute): void {
    this.active--;
    bumpMap(this.inFlightByRoute, route.routeId, -1);
    bumpMap(this.inFlightByProvider, route.provider, -1);
  }

  private routeHealth(routeId: string): RouteHealth {
    let health = this.health.get(routeId);
    if (!health) {
      health = {
        consecutiveUnhealthy: 0,
        circuitOpen: false,
        failuresByKind: {},
        rateLimits: 0,
        quotaExhausted: 0,
        concurrencyPressure: 0,
        pressureByKind: {},
      };
      this.health.set(routeId, health);
    }
    return health;
  }

  private noteSuccess(route: AiRoute): void {
    const health = this.routeHealth(route.routeId);
    health.consecutiveUnhealthy = 0;
    health.lastUnhealthyKind = undefined;
  }

  private noteAttemptOutcome(route: AiRoute, kind: AiFailureKind, pressure?: AiPressureKind): void {
    const health = this.routeHealth(route.routeId);
    bump(health.failuresByKind as Record<string, number>, kind);
    if (pressure) bump(health.pressureByKind as Record<string, number>, pressure);
    if (kind === 'concurrency-pressure') {
      health.concurrencyPressure++;
      return;
    }
    if (kind === 'rate-limit') {
      health.rateLimits++;
      return;
    }
    if (!CIRCUIT_UNHEALTHY.has(kind)) return;
    health.consecutiveUnhealthy++;
    health.lastUnhealthyKind = kind;
    if (!health.circuitOpen && health.consecutiveUnhealthy >= AI_POOL_CIRCUIT_FAILURE_THRESHOLD) {
      health.circuitOpen = true;
      health.circuitReason =
        `${kind} × ${health.consecutiveUnhealthy} consecutivos sin resultado válido`;
      this.stats.circuitOpenRoutes++;
    }
  }

  private providerCap(
    provider: string,
    key: 'providerMaxConcurrent' | 'providerMinIntervalMs',
  ): number | undefined {
    const values = this.routes
      .filter((route) => route.provider === provider)
      .map((route) => route.limits?.[key])
      .filter((value): value is number => value !== undefined);
    return values.length ? Math.min(...values) : undefined;
  }

  /**
   * After an explicit concurrency-pressure signal, remaining in-flight work
   * towards that provider converges to 1 for the rest of this run. It does not
   * open a circuit or mark quota exhaustion.
   */
  private tightenProviderConcurrency(provider: string): void {
    this.runtimeProviderMaxConcurrent.set(provider, 1);
  }

  private effectiveProviderMaxConcurrent(provider: string): number | undefined {
    const declared = this.providerCap(provider, 'providerMaxConcurrent');
    const runtime = this.runtimeProviderMaxConcurrent.get(provider);
    if (declared === undefined) return runtime;
    if (runtime === undefined) return declared;
    return Math.min(declared, runtime);
  }

  private atConcurrencyCap(map: Map<string, number>, key: string, cap: number | undefined): boolean {
    return cap !== undefined && (map.get(key) ?? 0) >= cap;
  }

  private routeSnapshots(): AiRouteRuntimeStats[] {
    return this.routes.map((route) => {
      const health = this.routeHealth(route.routeId);
      const httpRequests = this.stats.requestsByRoute[route.routeId] ?? 0;
      const valid = this.stats.classificationsByRoute[route.routeId] ?? 0;
      return {
        routeId: route.routeId,
        provider: route.provider,
        model: route.model,
        httpRequests,
        valid,
        failures: httpRequests - valid,
        failuresByKind: structuredClone(health.failuresByKind),
        rateLimits: health.rateLimits,
        quotaExhausted: health.quotaExhausted,
        concurrencyPressure: health.concurrencyPressure,
        pressureByKind: structuredClone(health.pressureByKind),
        circuitOpen: health.circuitOpen,
        ...(health.circuitReason ? { circuitReason: health.circuitReason } : {}),
        consecutiveFailures: health.consecutiveUnhealthy,
      };
    });
  }

  private estimateInputTokens(request: AiRequest, route: AiRoute): number {
    return route.transport.estimateInputTokens?.(request, route.model)
      ?? Math.ceil(Buffer.byteLength(JSON.stringify(request), 'utf8') / 3) + 128;
  }

  private retryWait(error: AiTransportError | undefined, attempt: number): number {
    if (error?.retryAfterMs !== undefined) return Math.max(0, error.retryAfterMs);
    return Math.min(
      AI_POOL_MAX_RETRY_WAIT_MS,
      AI_POOL_BACKOFF_BASE_MS * 2 ** attempt
        + (this.options.random ?? Math.random)() * AI_POOL_BACKOFF_BASE_MS,
    );
  }

  private cacheKey(requestKey: string, route: AiRoute): string {
    return hashAiInput({
      requestKey,
      provider: route.provider,
      model: route.model,
      routeId: route.routeId,
      transport: route.transport.cacheIdentity(route.model),
    });
  }

  private selectDiagnostics(diagnostics: AiCallDiagnostics, route: AiRoute, reason?: string): void {
    diagnostics.provider = route.provider;
    diagnostics.model = route.model;
    diagnostics.routeId = route.routeId;
    if (reason) addRoute(diagnostics, route, reason);
  }

  private routeForDiagnostics(diagnostics: AiCallDiagnostics): AiRoute {
    return this.routes.find((route) => route.routeId === diagnostics.routeId) ?? this.routes[0]!;
  }

  private redactForRoute(route: AiRoute, message: string): string {
    return route.transport.redact?.(message) ?? message;
  }

  private redactError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const route of this.routes) message = this.redactForRoute(route, message);
    return message;
  }

  private noUsableRouteError(lastError: unknown, diagnostics: AiCallDiagnostics): Error {
    const remembered = lastError
      ?? [...this.disabledRoutes.values()].at(-1)
      ?? [...this.fatalProviders.values()].at(-1);
    if (remembered !== undefined) {
      return this.finalizeLastError(remembered, diagnostics, 'IA: ninguna route restante utilizable');
    }
    return new AiRateLimitedError('IA: ninguna route tiene cuota, configuración o capacidad TPM disponible');
  }

  private nextAvailabilityError(lastError: unknown, diagnostics: AiCallDiagnostics): Error {
    if (lastError !== undefined) {
      return this.finalizeLastError(
        lastError,
        diagnostics,
        'IA: próxima disponibilidad fuera del presupuesto de espera',
      );
    }
    return new AiRateLimitedError('IA: próxima disponibilidad fuera del presupuesto de espera');
  }

  private deadlineWaitError(lastError: unknown, diagnostics: AiCallDiagnostics): Error {
    if (lastError !== undefined) {
      return this.finalizeLastError(lastError, diagnostics, 'tiempo agotado esperando cuota de IA');
    }
    return new Error('tiempo agotado esperando cuota de IA');
  }

  /**
   * Keep the original typed failure (timeout, HTTP 400, auth, …) and only add
   * scheduler context. Never replace a concrete provider error with a generic
   * "no capacity" rate-limit.
   */
  private finalizeLastError(
    lastError: unknown,
    diagnostics: AiCallDiagnostics,
    schedulerContext?: string,
  ): Error {
    const error = lastError instanceof Error ? lastError : new Error(String(lastError));
    const redacted = this.redactError(error);
    if (error.message !== redacted) error.message = redacted;
    const causes = formatAttemptCauses(diagnostics.failures);
    const context = [schedulerContext, causes ? `causas: ${causes}` : undefined]
      .filter((part): part is string => Boolean(part))
      .join('. ');
    if (context) appendErrorContext(error, context);
    if (error instanceof AiTransportError && error.kind === 'rate-limit') {
      return new AiRateLimitedError(error.message, {
        retryAfterMs: error.retryAfterMs,
        quotaExhausted: error.quotaExhausted,
        model: diagnostics.model ?? error.model,
      });
    }
    return error;
  }
}

/**
 * Taxonomy asked for formats, but empty is the correct final answer when the
 * source enumerates exclusive alternatives or still-undetermined programming.
 * Derived from observed facts — not a caller-set flag — so transports stay
 * provider-agnostic. Included in requestKey/flightKey so cache and in-flight
 * coalescing cannot reuse a resolved-empty result for a case that still needs
 * a concrete format.
 */
function acceptEmptyTaxonomyFormats(
  purpose: AiCallPurpose,
  requireFormats: boolean,
  observed: ObservedFacts,
): boolean {
  return purpose === 'taxonomy' && requireFormats && observedFormatChoiceIsUnresolved(observed);
}

function isUnsatisfactoryTaxonomyFormats(
  purpose: AiCallPurpose,
  requireFormats: boolean,
  value: unknown,
  acceptEmptyFormats: boolean,
): boolean {
  if (purpose !== 'taxonomy' || !requireFormats || acceptEmptyFormats) return false;
  const parsed = parseAiTaxonomy(value);
  return parsed.ok && taxonomyFormatsStillUnresolved(parsed.value);
}

function addRoute(diagnostics: AiCallDiagnostics, route: AiRoute, reason: string): void {
  const entry = routingEntry(route, reason);
  if (!diagnostics.routing!.some((item) => item.routeId === route.routeId && item.reason === reason)) {
    diagnostics.routing!.push(entry);
  }
}

function routingEntry(route: AiRoute, reason: string) {
  return { provider: route.provider, model: route.model, routeId: route.routeId, reason };
}

function pushFailure(
  diagnostics: AiCallDiagnostics,
  route: AiRoute,
  failure: AiAttemptFailure,
): void {
  diagnostics.failures = [
    ...(diagnostics.failures ?? []),
    { ...failure, provider: route.provider, model: route.model, routeId: route.routeId },
  ];
}

function formatAttemptCauses(failures: AiAttemptFailure[] | undefined): string | undefined {
  if (!failures?.length) return undefined;
  return failures.map((failure) => (
    [
      failure.routeId ?? failure.model,
      failure.kind,
      failure.status ? `HTTP ${failure.status}` : undefined,
      failure.code,
    ].filter(Boolean).join(' ')
  )).join('; ');
}

function appendErrorContext(error: Error, context: string): Error {
  if (!context || error.message.includes(context)) return error;
  error.message = `${error.message} (${context})`;
  return error;
}

function skipRouteWhenAlternativeExists(
  skipped: Set<string>,
  route: AiRoute,
  pool: readonly AiRoute[],
  available: (candidate: AiRoute) => boolean,
): void {
  if (pool.some((candidate) => candidate.routeId !== route.routeId && available(candidate))) {
    skipped.add(route.routeId);
  }
}

function intervalMsForRpm(rpm: number | undefined): number {
  if (rpm === undefined) return 0;
  return Math.ceil(60_000 / rpm);
}

function pressureReason(pressure: AiPressureKind | undefined): string {
  if (pressure === 'tpm') return 'rate-limit-tpm';
  if (pressure === 'otpm') return 'rate-limit-otpm';
  if (pressure === 'monthly') return 'rate-limit-monthly';
  if (pressure === 'daily') return 'daily-quota';
  if (pressure === 'request-frequency') return 'rate-limit-request-frequency';
  if (pressure === 'concurrency') return 'concurrency-pressure';
  if (pressure === 'capacity') return 'provider-busy';
  return 'rate-limit';
}

function bump(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function bumpMap(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function sleep(clock: SleepClock, ms: number, signal: AbortSignal): Promise<void> {
  if (clock !== systemClock) return abortable(clock.sleep(ms), signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    clearTimeout(timer);
  }
}
