# Formulario de contacto

`/contacto/` sigue siendo una página Astro estática. El formulario envía un `POST`
same-origin a `functions/api/contacto.ts`, una Cloudflare Pages Function sin
persistencia. La Function valida el payload, verifica Turnstile y llama directamente
a la REST API de Cloudflare Email Service.

La recepción directa de `hola@clasicamadrid.com` se configura fuera de esta repo con
Cloudflare Email Routing.

## Configuración de Cloudflare Pages

Variable disponible durante el build:

- `PUBLIC_TURNSTILE_SITE_KEY`: site key pública del widget de Turnstile. En
  `astro dev`, en `astro build` local, en la CI y en los deployments preview de
  Cloudflare Pages, si falta esta variable la página usa la site key de test
  oficial (`1x00000000000000000000AA`), que siempre muestra una verificación
  válida. Un secret real de producción rechazará ese token de prueba. En el
  build de producción de Cloudflare Pages (`CF_PAGES=1` y
  `CF_PAGES_BRANCH=main`) la variable es obligatoria: si falta, el build de
  `/contacto/` falla y no se publica el formulario con la clave de prueba.

Variables runtime no sensibles:

- `CLOUDFLARE_ACCOUNT_ID`: cuenta desde la que se llama a Email Service.
- `CONTACT_FROM`: dirección de email del remitente verificado, sin nombre
  visible. Ejemplo: `hola@clasicamadrid.com`. Si se omite, la Function usa esa
  misma dirección. Email Service recibe `from.address` con ese valor y
  `from.name` fijo `Clásica Madrid`. El visitante no controla el remitente, el
  destinatario ni el asunto.
- `TURNSTILE_ALLOWED_HOSTNAMES`: hostnames exactos separados por comas. El default es
  `clasicamadrid.com,www.clasicamadrid.com`. Añade el hostname concreto de preview si
  quieres probar un deployment de preview y autorízalo también en el widget Turnstile.

Secrets runtime:

- `TURNSTILE_SECRET_KEY`: secret del widget de Turnstile.
- `CLOUDFLARE_EMAIL_API_TOKEN`: token con permiso para enviar email.
- `CONTACT_RECIPIENT`: dirección privada que recibe las notificaciones del formulario.

`CONTACT_RECIPIENT`, el secret de Turnstile y el token de Email Service nunca deben ser
variables `PUBLIC_*`, variables de build ni valores versionados.

## Prueba local

Los tests unitarios mockean Turnstile y Email Service; no hacen llamadas externas ni
envían correos. Para probar la página y el flujo visual estático:

```bash
npm run build
npm run test:e2e
```

`astro preview` no ejecuta Pages Functions. Para probar el endpoint localmente, crea
un `.dev.vars` gitignorado a partir de la sección de contacto de `.env.example`, usa
las claves de test oficiales de Turnstile y ejecuta:

```bash
npm run build
npx wrangler@latest pages dev dist
```

Una prueba integral del envío requiere además credenciales de Email Service y un
remitente/destinatario de prueba permitidos por la cuenta. No uses el destinatario
privado real en fixtures, logs ni capturas.
