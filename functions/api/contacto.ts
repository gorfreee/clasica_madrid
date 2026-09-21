const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';
const DEFAULT_CONTACT_FROM_ADDRESS = 'hola@clasicamadrid.com';
const CONTACT_FROM_NAME = 'Clásica Madrid';
const DEFAULT_ALLOWED_HOSTNAMES = 'clasicamadrid.com,www.clasicamadrid.com';
const EXPECTED_TURNSTILE_ACTION = 'contacto';
const MAX_BODY_BYTES = 16_384;
const EXTERNAL_REQUEST_TIMEOUT_MS = 8_000;

export const CONTACT_REASONS = [
  'Corrección',
  'Añadir un concierto',
  'Colaboración',
  'Otro',
] as const;

type ContactReason = (typeof CONTACT_REASONS)[number];

export type ContactEnv = {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
  CONTACT_RECIPIENT?: string;
  CONTACT_FROM?: string;
};

type ContactPayload = {
  nombre: string;
  email: string;
  motivo: ContactReason;
  mensaje: string;
  turnstileToken: string;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type HandlerDependencies = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type PagesContext = {
  request: Request;
  env: ContactEnv;
};

type TurnstileResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
};

type CloudflareEmailResult = {
  success?: boolean;
};

export async function onRequest(context: PagesContext): Promise<Response> {
  return handleContactRequest(context.request, context.env);
}

export async function handleContactRequest(
  request: Request,
  env: ContactEnv,
  dependencies: HandlerDependencies = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(
      { ok: false, code: 'method_not_allowed', message: 'Método no permitido.' },
      405,
      { Allow: 'POST' },
    );
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return jsonResponse(
      { ok: false, code: 'unsupported_media_type', message: 'Formato de solicitud no válido.' },
      415,
    );
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return invalidPayload('El mensaje es demasiado largo.');
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return invalidPayload('No hemos podido leer el formulario.');
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return invalidPayload('El mensaje es demasiado largo.');
  }

  const params = new URLSearchParams(rawBody);
  const honeypot = normalizedField(params, 'website');
  if (honeypot) return successfulResponse();

  const parsed = validatePayload(params);
  if (!parsed.ok) return invalidPayload(parsed.message);

  const config = contactConfig(env);
  if (!config) {
    return genericFailure('configuration_error', 503);
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? EXTERNAL_REQUEST_TIMEOUT_MS;
  const remoteIp = request.headers.get('CF-Connecting-IP')?.trim();

  const verified = await verifyTurnstile(
    parsed.payload.turnstileToken,
    remoteIp,
    config.turnstileSecret,
    config.allowedHostnames,
    fetchImpl,
    timeoutMs,
  );
  if (!verified) {
    return jsonResponse(
      {
        ok: false,
        code: 'verification_failed',
        message: 'No hemos podido verificar el envío. Inténtalo de nuevo.',
      },
      400,
    );
  }

  const sent = await sendContactEmail(parsed.payload, config, fetchImpl, timeoutMs);
  if (!sent) return genericFailure('delivery_failed', 502);

  return successfulResponse();
}

function validatePayload(
  params: URLSearchParams,
): { ok: true; payload: ContactPayload } | { ok: false; message: string } {
  const nombre = normalizedField(params, 'nombre');
  const email = normalizedField(params, 'email');
  const motivo = normalizedField(params, 'motivo');
  const mensaje = normalizedField(params, 'mensaje');
  const turnstileToken = normalizedField(params, 'cf-turnstile-response');

  if (nombre.length > 100) return { ok: false, message: 'El nombre es demasiado largo.' };
  if (!email || email.length > 254 || !isValidEmail(email)) {
    return { ok: false, message: 'Introduce un email válido.' };
  }
  if (!CONTACT_REASONS.includes(motivo as ContactReason)) {
    return { ok: false, message: 'Selecciona un motivo válido.' };
  }
  if (!mensaje || mensaje.length > 5_000) {
    return { ok: false, message: 'El mensaje debe tener entre 1 y 5.000 caracteres.' };
  }
  if (!turnstileToken || turnstileToken.length > 2_048) {
    return { ok: false, message: 'Completa la verificación antes de enviar.' };
  }

  return {
    ok: true,
    payload: {
      nombre,
      email,
      motivo: motivo as ContactReason,
      mensaje,
      turnstileToken,
    },
  };
}

function normalizedField(params: URLSearchParams, name: string): string {
  return (params.get(name) ?? '').trim();
}

function isValidEmail(value: string): boolean {
  return !/[\r\n]/u.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function contactConfig(env: ContactEnv) {
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const emailApiToken = env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
  const recipient = env.CONTACT_RECIPIENT?.trim();
  const from = env.CONTACT_FROM?.trim() || DEFAULT_CONTACT_FROM_ADDRESS;
  const allowedHostnames = new Set(
    (env.TURNSTILE_ALLOWED_HOSTNAMES || DEFAULT_ALLOWED_HOSTNAMES)
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!turnstileSecret || !accountId || !emailApiToken || !recipient || !isValidEmail(from)) {
    return null;
  }
  if (allowedHostnames.size === 0) return null;

  return {
    turnstileSecret,
    accountId,
    emailApiToken,
    recipient,
    from,
    allowedHostnames,
  };
}

async function verifyTurnstile(
  token: string,
  remoteIp: string | null | undefined,
  secret: string,
  allowedHostnames: Set<string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const response = await safeFetch(
    fetchImpl,
    TURNSTILE_VERIFY_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    },
    timeoutMs,
  );
  if (!response?.ok) return false;

  const result = await safeJson<TurnstileResult>(response);
  const hostname = result?.hostname?.trim().toLowerCase();
  return Boolean(
    result?.success &&
      hostname &&
      allowedHostnames.has(hostname) &&
      result.action === EXPECTED_TURNSTILE_ACTION,
  );
}

async function sendContactEmail(
  payload: ContactPayload,
  config: NonNullable<ReturnType<typeof contactConfig>>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  const text = [
    `Motivo: ${payload.motivo}`,
    ...(payload.nombre ? [`Nombre: ${payload.nombre}`] : []),
    `Email: ${payload.email}`,
    '',
    'Mensaje:',
    payload.mensaje,
  ].join('\n');

  const response = await safeFetch(
    fetchImpl,
    `${CLOUDFLARE_API_ROOT}/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.emailApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: [config.recipient],
        from: {
          address: config.from,
          name: CONTACT_FROM_NAME,
        },
        reply_to: payload.email,
        subject: `[Clásica Madrid] ${payload.motivo}`,
        text,
      }),
    },
    timeoutMs,
  );
  if (!response?.ok) return false;

  const result = await safeJson<CloudflareEmailResult>(response);
  return result?.success === true;
}

async function safeFetch(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function invalidPayload(message: string): Response {
  return jsonResponse({ ok: false, code: 'invalid_request', message }, 400);
}

function genericFailure(code: string, status: number): Response {
  return jsonResponse(
    {
      ok: false,
      code,
      message: 'No hemos podido enviar el mensaje. Puedes escribirnos a hola@clasicamadrid.com.',
    },
    status,
  );
}

function successfulResponse(): Response {
  return jsonResponse({ ok: true, message: 'Gracias. Tu mensaje se ha enviado.' }, 200);
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}
