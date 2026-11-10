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

export const YouTubeLinkInputSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  intent: z.enum(['video', 'playlist']).optional(),
  order: z.enum(['newest', 'oldest']).default('newest'),
});
export const YouTubeLinksImportRequestSchema = z.object({
  inputs: z.array(YouTubeLinkInputSchema).min(1).max(50),
  refresh: z.boolean().default(false),
});
export const YouTubeCollectionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  title: z.string(),
  kind: z.enum(['saved_videos', 'playlist', 'creator_uploads']),
  externalKey: z.string(),
  revision: z.string(),
  lastSuccessfulRefreshAt: z.number().nullable(),
  lastRefreshError: z.string().nullable(),
});
export const YouTubeCollectionEntrySchema = z.object({
  id: z.string(),
  position: z.number().int().nonnegative(),
  videoId: z.string().nullable(),
  status: z.enum(['available', 'pending', 'unavailable']),
  message: z.string().nullable(),
  program: ContentProgramSchema.nullable(),
});
export const YouTubeCollectionPageSchema = z.object({
  sourceId: z.string(),
  libraryId: z.string(),
  collection: YouTubeCollectionSchema,
  entries: z.array(YouTubeCollectionEntrySchema),
  total: z.number().int().nonnegative(),
});
export const YouTubeLinksImportResponseSchema = z.object({
  sourceId: z.string(),
  libraryId: z.string(),
  imports: z.array(
    z.object({
      inputIndex: z.number().int().nonnegative(),
      kind: z.enum(['video', 'playlist', 'creator']),
      status: z.enum(['complete', 'failed', 'duplicate']),
      title: z.string(),
      message: z.string().nullable(),
      collection: YouTubeCollectionSchema.nullable(),
      changes: z
        .object({
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
        })
        .optional(),
      entries: z.array(YouTubeCollectionEntrySchema),
    }),
  ),
});
export type YouTubeLinkInput = z.infer<typeof YouTubeLinkInputSchema>;
export type YouTubeCollection = z.infer<typeof YouTubeCollectionSchema>;
export type YouTubeCollectionEntry = z.infer<
  typeof YouTubeCollectionEntrySchema
>;
export type YouTubeCollectionPage = z.infer<typeof YouTubeCollectionPageSchema>;
export type YouTubeLinksImportResponse = z.infer<
  typeof YouTubeLinksImportResponseSchema
>;
