import { E_ALREADY_LOCKED } from 'async-mutex';
import {
  YouTubeHealthResponseSchema,
  YouTubeImportRequestSchema,
  YouTubeImportResponseSchema,
  YouTubeLinksImportRequestSchema,
  YouTubeLinksImportResponseSchema,
  YouTubeCollectionSchema,
  YouTubeCollectionPageSchema,
} from '@tunarr/types/schemas';
import { z } from 'zod/v4';
import { container } from '../container.ts';
import {
  YouTubeAdapter,
  YouTubeError,
  normalizeYouTubeVideoUrl,
  normalizeYouTubeUrl,
} from '../external/youtube/YouTubeAdapter.ts';
import { YouTubeImportService } from '../services/YouTubeImportService.ts';
import { YouTubeMediaRelay } from '../stream/YouTubeMediaRelay.ts';
import type { RouterPluginAsyncCallback } from '../types/serverType.ts';

// Fastify's async plugin contract; registration itself performs no I/O.
// eslint-disable-next-line @typescript-eslint/require-await
export const youtubeApi: RouterPluginAsyncCallback = async (fastify) => {
  const adapter = container.get(YouTubeAdapter);
  const relay = container.get(YouTubeMediaRelay);
  const imports = container.get(YouTubeImportService);
  fastify.get(
    '/media-sources/:id/youtube/collections',
    {
      schema: {
        operationId: 'getYouTubeCollections',
        tags: ['Media Source'],
        params: z.object({ id: z.string() }),
        response: { 200: z.array(YouTubeCollectionSchema), 400: z.string() },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await imports.listCollections(request.params.id));
      } catch {
        return reply
          .status(400)
          .send('YouTube source or library is unavailable.');
      }
    },
  );
  fastify.get(
    '/media-sources/:id/youtube/collections/:collectionId/entries',
    {
      schema: {
        operationId: 'getYouTubeCollectionEntries',
        tags: ['Media Source'],
        params: z.object({ id: z.string(), collectionId: z.string() }),
        querystring: z.object({
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          order: z.enum(['newest', 'oldest']).default('newest'),
          revision: z.string().optional(),
        }),
        response: {
          200: YouTubeCollectionPageSchema,
          400: z.string(),
          409: z.string(),
        },
      },
    },
    async (request, reply) => {
      try {
        const { offset, limit, order, revision } = request.query;
        return reply.send(
          await imports.collectionPage(
            request.params.id,
            request.params.collectionId,
            offset,
            limit,
            order,
            revision,
          ),
        );
      } catch (error) {
        return reply
          .status(
            error instanceof YouTubeError && error.code === 'INVALID_METADATA'
              ? 409
              : 400,
          )
          .send(
            error instanceof YouTubeError
              ? error.message
              : 'Could not load this collection.',
          );
      }
    },
  );
  fastify.post(
    '/media-sources/:id/youtube/imports',
    {
      schema: {
        operationId: 'importYouTubeLinks',
        tags: ['Media Source'],
        params: z.object({ id: z.string() }),
        body: YouTubeLinksImportRequestSchema,
        response: {
          200: YouTubeLinksImportResponseSchema,
          400: z.string(),
          409: z.string(),
          503: z.string(),
        },
      },
    },
    async (request, reply) => {
      const owner = new AbortController();
      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          owner.abort();
        }
      };
      reply.raw.once('close', disconnected);
      try {
        for (const input of request.body.inputs) {
          normalizeYouTubeUrl(input.url, input.intent);
        }
        return reply.send(
          await request.serverCtx.mediaSourceScanCoordinator.importYouTubeLinks(
            request.params.id,
            request.body.inputs,
            owner.signal,
            request.body.refresh,
          ),
        );
      } catch (error) {
        if (error === E_ALREADY_LOCKED) {
          return reply
            .status(409)
            .send(
              'This library is busy. Wait for its current operation or cancel and retry.',
            );
        }
        if (error instanceof YouTubeError) {
          return reply
            .status(
              [
                'TOOL_UNAVAILABLE',
                'VERSION_MISMATCH',
                'RUNTIME_UNAVAILABLE',
              ].includes(error.code)
                ? 503
                : 400,
            )
            .send(error.message);
        }
        return reply
          .status(400)
          .send(
            owner.signal.aborted
              ? 'YouTube import cancelled.'
              : 'YouTube import could not finish. Saved library data and programming were not cleared.',
          );
      } finally {
        reply.raw.removeListener('close', disconnected);
      }
    },
  );
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/youtube/media/:inputId',
    config: { authRequired: false },
    schema: { hide: true },
    handler: async (request, reply) => {
      // This authenticated media capability has its own validation and never
      // accepts an upstream URL. Do not serialize or log a live input.
      reply.hijack();
      await relay.handle(request.raw, reply.raw);
    },
  });
  fastify.get(
    '/youtube/health',
    {
      schema: {
        operationId: 'getYouTubeHealth',
        tags: ['Media Source'],
        response: { 200: YouTubeHealthResponseSchema },
      },
    },
    async () => adapter.health(AbortSignal.timeout(10_000)),
  );
  fastify.post(
    '/media-sources/:id/youtube/import',
    {
      schema: {
        operationId: 'importYouTubeVideo',
        tags: ['Media Source'],
        params: z.object({ id: z.string() }),
        body: YouTubeImportRequestSchema,
        response: {
          200: YouTubeImportResponseSchema,
          400: z.string(),
          409: z.string(),
          503: z.string(),
        },
      },
    },
    async (request, reply) => {
      const owner = new AbortController();
      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          owner.abort();
        }
      };
      reply.raw.once('close', disconnected);
      try {
        const { videoId } = normalizeYouTubeVideoUrl(
          request.body.url,
          request.body.intent,
        );
        return reply.send(
          await request.serverCtx.mediaSourceScanCoordinator.importYouTubeVideo(
            request.params.id,
            videoId,
            owner.signal,
          ),
        );
      } catch (error) {
        if (error === E_ALREADY_LOCKED) {
          return reply
            .status(409)
            .send(
              'This library is busy. Wait for its current operation or cancel and retry.',
            );
        }
        if (error instanceof YouTubeError) {
          const dependency = [
            'TOOL_UNAVAILABLE',
            'VERSION_MISMATCH',
            'RUNTIME_UNAVAILABLE',
          ].includes(error.code);
          return reply.status(dependency ? 503 : 400).send(error.message);
        }
        return reply
          .status(400)
          .send(
            owner.signal.aborted
              ? 'YouTube import cancelled.'
              : 'YouTube import could not finish. Saved library data and programming were not cleared.',
          );
      } finally {
        reply.raw.removeListener('close', disconnected);
      }
    },
  );
};
