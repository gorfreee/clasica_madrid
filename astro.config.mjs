import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://clasicamadrid.com',
  integrations: [sitemap()],
  // Keep HTML-aware whitespace; Astro 7 defaults to JSX collapsing.
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
  },
});
