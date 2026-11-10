import { z } from 'zod/v4';
import { ContentProgramSchema } from './lineups.js';

export const YouTubeImportRequestSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  intent: z.literal('video').optional(),
});

export const YouTubeImportResponseSchema = z.object({
  sourceId: z.string(),
  libraryId: z.string(),
  program: ContentProgramSchema,
});

export const YouTubeHealthResponseSchema = z.object({
  available: z.boolean(),
  extractorVersion: z.string().optional(),
  message: z.string(),
});

export type YouTubeImportResponse = z.infer<typeof YouTubeImportResponseSchema>;
