import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://clasicamadrid.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
