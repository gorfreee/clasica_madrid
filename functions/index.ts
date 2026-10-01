import { hasAgendaFilterParams } from '../src/lib/domain/filters.ts';

type PagesContext = {
  request: Request;
  next: () => Promise<Response>;
};

/** The SSG home cannot see request-time query strings; leave its HTML intact. */
export async function onRequest(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  const response = await context.next();
  if (url.pathname !== '/' || !hasAgendaFilterParams(url.searchParams)) return response;

  // Asset responses may have immutable headers. Wrap without consuming the body
  // or mutating the original cached response used for the unfiltered home.
  const filteredResponse = new Response(response.body, response);
  filteredResponse.headers.set('X-Robots-Tag', 'noindex, follow');
  return filteredResponse;
}
