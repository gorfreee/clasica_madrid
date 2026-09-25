import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { blogEntrySchema } from './lib/blog/schema.ts';

export const collections = {
  blog: defineCollection({
    loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
    schema: ({ image }) => blogEntrySchema(image()),
  }),
};
