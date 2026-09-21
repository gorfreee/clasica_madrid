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
  CONTACT_FROM: 'Clásica Madrid <hola@clasicamadrid.com>',
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
      from: 'Clásica Madrid <hola@clasicamadrid.com>',
      reply_to: 'ana@example.com',
      subject: '[Clásica Madrid] Corrección',
    });
    expect(email.text).toContain('Nombre: Ana');
    expect(email.text).toContain('La hora publicada debería ser las 19:30.');
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
