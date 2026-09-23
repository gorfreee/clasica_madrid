import { describe, expect, it, vi } from 'vitest';
import {
  handleContactRequest,
  type ContactEnv,
} from '../functions/api/contacto.ts';

const env: ContactEnv = {
  TURNSTILE_SECRET_KEY: 'turnstile-secret-test',
  TURNSTILE_ALLOWED_HOSTNAMES: 'clasicamadrid.com,www.clasicamadrid.com',
  CLOUDFLARE_ACCOUNT_ID: 'account-test',
  CLOUDFLARE_EMAIL_API_TOKEN: 'email-token-test',
  CONTACT_RECIPIENT: 'private-recipient@example.test',
  CONTACT_FROM: 'hola@clasicamadrid.com',
};

const validFields = {
  nombre: 'Ana',
  email: 'ana@example.com',
  motivo: 'Corrección',
  mensaje: 'La hora publicada debería ser las 19:30.',
  website: '',
  'cf-turnstile-response': 'valid-test-token',
};

function requestWith(fields: Record<string, string> = validFields): Request {
  return new Request('https://clasicamadrid.com/api/contacto', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: new URLSearchParams(fields),
  });
}

function successfulExternalFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/siteverify')) {
      return Response.json({
        success: true,
        hostname: 'clasicamadrid.com',
        action: 'contacto',
      });
    }
    if (url.includes('/email/sending/send')) return Response.json({ success: true });
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe('Cloudflare Pages Function de contacto', () => {
  it('acepta un payload válido, verifica Turnstile y envía el email', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(requestWith(), env, { fetchImpl });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: 'Gracias. Tu mensaje se ha enviado.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const turnstileCall = fetchImpl.mock.calls[0];
    expect(String(turnstileCall?.[0])).toContain('/turnstile/v0/siteverify');
    const turnstileBody = turnstileCall?.[1]?.body as URLSearchParams;
    expect(turnstileBody.get('response')).toBe('valid-test-token');
    expect(turnstileBody.get('remoteip')).toBe('203.0.113.10');

    const emailCall = fetchImpl.mock.calls[1];
    expect(String(emailCall?.[0])).toContain('/accounts/account-test/email/sending/send');
    const email = JSON.parse(String(emailCall?.[1]?.body));
    expect(email).toMatchObject({
      to: ['private-recipient@example.test'],
      from: {
        address: 'hola@clasicamadrid.com',
        name: 'Clásica Madrid',
      },
      reply_to: 'ana@example.com',
      subject: '[Clásica Madrid] Corrección',
    });
    expect(email.from).toEqual({
      address: env.CONTACT_FROM,
      name: 'Clásica Madrid',
    });
    expect(email.text).toContain('Nombre: Ana');
    expect(email.text).toContain('La hora publicada debería ser las 19:30.');
    expect(email.text).not.toContain('Origen:');
    expect(email.text).not.toContain('Evento ID:');
    expect(email.text).not.toContain('Ficha:');
  });

  it('ignora from, to y subject enviados por el visitante', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({
        ...validFields,
        motivo: 'Colaboración',
        from: 'atacante@example.com',
        to: 'atacante@example.com',
        subject: 'Asunto libre del visitante',
      }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(200);
    const email = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(email.to).toEqual([env.CONTACT_RECIPIENT]);
    expect(email.from).toEqual({
      address: 'hola@clasicamadrid.com',
      name: 'Clásica Madrid',
    });
    expect(email.reply_to).toBe('ana@example.com');
    expect(email.subject).toBe('[Clásica Madrid] Colaboración');
    expect(email.subject).not.toContain('Asunto libre');
    expect(JSON.stringify(email)).not.toContain('atacante@example.com');
  });

  it('usa la dirección por defecto cuando CONTACT_FROM no está definido', async () => {
    const fetchImpl = successfulExternalFetch();
    const { CONTACT_FROM: _ignored, ...envWithoutFrom } = env;
    const response = await handleContactRequest(requestWith(), envWithoutFrom, { fetchImpl });

    expect(response.status).toBe(200);
    const email = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(email.from).toEqual({
      address: 'hola@clasicamadrid.com',
      name: 'Clásica Madrid',
    });
    expect(email.reply_to).toBe(validFields.email);
    expect(email.to).toEqual([env.CONTACT_RECIPIENT]);
  });

  it('rechaza un CONTACT_FROM que no es solo una dirección', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith(),
      { ...env, CONTACT_FROM: 'Clásica Madrid <hola@clasicamadrid.com>' },
      { fetchImpl },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'configuration_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rechaza un email inválido antes de llamar a servicios externos', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({ ...validFields, email: 'no-es-un-email' }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rechaza un motivo fuera del enum cerrado', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({ ...validFields, motivo: 'Publicidad' }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['nombre', 'n'.repeat(101)],
    ['email', `${'a'.repeat(246)}@example.com`],
    ['mensaje', 'm'.repeat(5_001)],
    ['cf-turnstile-response', 't'.repeat(2_049)],
  ])('rechaza el campo %s cuando supera el límite', async (field, value) => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({ ...validFields, [field]: value }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('trata el honeypot como éxito sin verificar ni enviar', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({ ...validFields, website: 'https://spam.example' }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it.each([
    [{ success: false }, 'fallo de Siteverify'],
    [{ success: true, hostname: 'evil.example', action: 'contacto' }, 'hostname inesperado'],
    [{ success: true, hostname: 'clasicamadrid.com', action: 'registro' }, 'action inesperada'],
  ])('rechaza Turnstile ante %s (%s)', async (turnstileResult) => {
    const fetchImpl = vi.fn(async () => Response.json(turnstileResult));
    const response = await handleContactRequest(requestWith(), env, { fetchImpl });

    expect(response.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'verification_failed',
    });
  });

  it('devuelve un error genérico si falla Cloudflare Email Service', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/siteverify')) {
        return Response.json({
          success: true,
          hostname: 'clasicamadrid.com',
          action: 'contacto',
        });
      }
      return Response.json({ success: false }, { status: 503 });
    });
    const response = await handleContactRequest(requestWith(), env, { fetchImpl });
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).toContain('No hemos podido enviar el mensaje');
    expect(body).not.toContain(env.CONTACT_RECIPIENT!);
    expect(body).not.toContain(env.TURNSTILE_SECRET_KEY!);
    expect(body).not.toContain(env.CLOUDFLARE_EMAIL_API_TOKEN!);
  });

  it('añade al email el contexto válido de una ficha, sin convertir el path en URL', async () => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(
      requestWith({
        ...validFields,
        origin: 'event_feedback',
        event_id: 'evt_andromeda_perseo_publico_2026',
        event_slug: 'andromeda-y-perseo-publico-general',
        event_url: 'https://evil.example/phish',
        ficha: 'https://evil.example/eventos/x/',
      }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(200);
    const email = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(email.subject).toBe('[Clásica Madrid] Corrección');
    expect(email.reply_to).toBe('ana@example.com');
    expect(email.text).toBe(
      [
        'Motivo: Corrección',
        'Nombre: Ana',
        'Email: ana@example.com',
        'Origen: Corrección de ficha de evento',
        'Evento ID: evt_andromeda_perseo_publico_2026',
        'Ficha: /eventos/andromeda-y-perseo-publico-general/',
        '',
        'Mensaje:',
        'La hora publicada debería ser las 19:30.',
      ].join('\n'),
    );
    expect(email.text).not.toContain('http');
    expect(JSON.stringify(email)).not.toContain('evil.example');
  });

  it.each([
    ['origin desconocido', { origin: 'newsletter', event_id: 'evt_ok', event_slug: 'recital' }],
    ['id que no es de evento', { origin: 'event_feedback', event_id: 'ven_auditorio', event_slug: 'recital' }],
    ['id demasiado largo', { origin: 'event_feedback', event_id: `evt_${'a'.repeat(120)}`, event_slug: 'recital' }],
    ['slug demasiado largo', { origin: 'event_feedback', event_id: 'evt_ok', event_slug: 'a'.repeat(121) }],
    ['id con salto de línea', { origin: 'event_feedback', event_id: 'evt_ok\r\nBcc: evil@example.com', event_slug: 'recital' }],
    ['slug con salto de línea', { origin: 'event_feedback', event_id: 'evt_ok', event_slug: 'recital\nhttps://evil.example' }],
    ['path arbitrario', { origin: 'event_feedback', event_id: 'evt_ok', event_slug: 'https://evil.example/eventos/x' }],
    ['slug con barras', { origin: 'event_feedback', event_id: 'evt_ok', event_slug: '../etc/passwd' }],
    ['sin contexto', {}],
  ])('ignora un contexto de ficha no confiable (%s) y envía el contacto normal', async (_label, extra) => {
    const fetchImpl = successfulExternalFetch();
    const response = await handleContactRequest(requestWith({ ...validFields, ...extra }), env, { fetchImpl });

    expect(response.status).toBe(200);
    const email = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(email.subject).toBe('[Clásica Madrid] Corrección');
    expect(email.text).toBe(
      [
        'Motivo: Corrección',
        'Nombre: Ana',
        'Email: ana@example.com',
        '',
        'Mensaje:',
        'La hora publicada debería ser las 19:30.',
      ].join('\n'),
    );
    expect(JSON.stringify(email)).not.toContain('evil');
    expect(JSON.stringify(email)).not.toContain('Bcc');
    expect(JSON.stringify(email)).not.toContain('passwd');
  });

  it('acepta un id y un slug en el límite de 120 caracteres', async () => {
    const fetchImpl = successfulExternalFetch();
    const eventId = `evt_${'a'.repeat(116)}`;
    const eventSlug = 'a'.repeat(120);
    expect(eventId).toHaveLength(120);
    expect(eventSlug).toHaveLength(120);

    const response = await handleContactRequest(
      requestWith({
        ...validFields,
        origin: 'event_feedback',
        event_id: eventId,
        event_slug: eventSlug,
      }),
      env,
      { fetchImpl },
    );

    expect(response.status).toBe(200);
    const email = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(email.text).toContain(`Evento ID: ${eventId}`);
    expect(email.text).toContain(`Ficha: /eventos/${eventSlug}/`);
  });

  it('acepta únicamente POST con formulario urlencoded', async () => {
    const getResponse = await handleContactRequest(
      new Request('https://clasicamadrid.com/api/contacto'),
      env,
    );
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get('allow')).toBe('POST');

    const jsonResponse = await handleContactRequest(
      new Request('https://clasicamadrid.com/api/contacto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(jsonResponse.status).toBe(415);
  });
});
