import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import type { AstroIntegration } from 'astro';
import { serializeSitemapItem, sitemapPageFilter } from './src/lib/presentation/sitemap.ts';
import { FULL_AGENDA_FRAGMENT_PATH } from './src/lib/presentation/urls.ts';

function fullAgendaFragment(): AstroIntegration {
  return {
    name: 'full-agenda-fragment',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        injectRoute({
          pattern: FULL_AGENDA_FRAGMENT_PATH.replace(/\/$/, ''),
          prerender: true,
          entrypoint: './src/fragments/full-agenda.astro',
        });
      },
    },
  };
}

export default defineConfig({
  site: 'https://clasicamadrid.com',
  trailingSlash: 'always',
  integrations: [
    fullAgendaFragment(),
    sitemap({
      filter: sitemapPageFilter,
      serialize: serializeSitemapItem,
    }),
  ],
  // Keep HTML-aware whitespace; Astro 7 defaults to JSX collapsing.
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
  },
});
