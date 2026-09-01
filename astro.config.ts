import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { serializeSitemapItem, sitemapPageFilter } from './src/lib/presentation/sitemap.ts';

export default defineConfig({
  site: 'https://clasicamadrid.com',
  trailingSlash: 'always',
  integrations: [
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
