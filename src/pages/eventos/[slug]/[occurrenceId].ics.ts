import type { APIRoute } from 'astro';
import { listCalendarStaticPaths, renderIcs, type CalendarIcsProps } from '../../../lib/presentation/calendar.ts';
import { loadPublishedCatalog } from '../../../lib/repository/load.ts';

export const prerender = true;

export async function getStaticPaths() {
  return listCalendarStaticPaths(await loadPublishedCatalog());
}

/** Static file. Cloudflare Pages applies `public/_headers` for the media type. */
export const GET: APIRoute<CalendarIcsProps> = ({ props }) => {
  const occurrence = props.occurrence;
  if (!occurrence) return new Response('Not found', { status: 404 });
  return new Response(renderIcs(occurrence), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${occurrence.id}.ics"`,
      'X-Robots-Tag': 'noindex',
    },
  });
};
