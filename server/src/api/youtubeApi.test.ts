import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { container } from '../container.ts';
import { DBAccess } from '../db/DBAccess.ts';
import {
  YouTubeAdapter,
  YouTubeError,
} from '../external/youtube/YouTubeAdapter.ts';
import {
  YouTubeLinksImportResponseSchema,
  YouTubeCollectionPageSchema,
} from '@tunarr/types/schemas';
import type {
  YouTubeListing,
  YouTubeVideoMetadata,
} from '../external/youtube/YouTubeAdapter.ts';
import type { MediaSourceId } from '../db/schema/base.ts';
import { MediaSourceScanCoordinator } from '../services/scanner/MediaSourceScanCoordinator.ts';
import { MeilisearchService } from '../services/MeilisearchService.ts';
import { getAvailablePort } from '../util/net.ts';
import { initTestApp, dbResult } from '../../tests/testServer.ts';
import { ApiProgramConverters } from './ApiProgramConverters.ts';

let app: FastifyInstance;
let metadata: MockInstance<YouTubeAdapter['metadata']>;
let listing: MockInstance<YouTubeAdapter['listing']>;

beforeAll(async () => {
  app = await initTestApp(await getAvailablePort(), {
    registerGuideTask: true,
  });
  metadata = vi
    .spyOn(container.get(YouTubeAdapter), 'metadata')
    .mockResolvedValue({
      id: 'aqz-KE-bpKQ',
      title: 'Saved video',
      durationSeconds: 635,
      description: 'An independently stored description.',
      thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      creatorId: 'UC-fixture',
      creatorName: 'Fixture creator',
      uploadDate: '20141110',
      tags: ['animation'],
    });
  listing = vi.spyOn(container.get(YouTubeAdapter), 'listing');
  vi.spyOn(
    container.get(MeilisearchService),
    'indexOtherVideo',
  ).mockResolvedValue([]);
}, 30_000);

afterAll(async () => {
  await app?.close();
  await dbResult?.cleanup();
});

test('one metadata import uses normal source/program/artwork owners, survives reopen and reuses identity', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/media-sources',
    payload: { type: 'youtube', name: 'Video fixture', pathReplacements: [] },
  });
  expect(created.statusCode).toBe(201);
  const { id } = created.json<{ id: string }>();
  const imported = await app.inject({
    method: 'POST',
    url: `/api/media-sources/${id}/youtube/import`,
    payload: { url: 'https://youtu.be/aqz-KE-bpKQ' },
  });
  expect(imported.statusCode, imported.body).toBe(200);
  const result = imported.json<{
    sourceId: string;
    libraryId: string;
    program: {
      id: string;
      program: { type: string; title: string; summary: string };
    };
  }>();
  expect(result.sourceId).toBe(id);
  expect(result.program.program).toMatchObject({
    type: 'other_video',
    title: 'Saved video',
    summary: 'An independently stored description.',
  });
  const db = DBAccess.instance.drizzle;
  if (!db) {
    throw new Error('Database fixture not initialized');
  }
  const saved = await db.query.program.findFirst({
    where: (p, { eq }) => eq(p.uuid, result.program.id),
    with: { artwork: true, externalIds: true, versions: true },
  });
  expect(saved).toMatchObject({
    sourceType: 'youtube',
    duration: 635000,
    youtubeMetadata: {
      creatorId: 'UC-fixture',
      creatorName: 'Fixture creator',
    },
  });
  expect(saved?.versions).toEqual([]);
  expect(saved?.artwork).toEqual([
    expect.objectContaining({
      artworkType: 'thumbnail',
      sourcePath: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    }),
  ]);
  expect(saved?.externalIds).toEqual([
    expect.objectContaining({
      sourceType: 'youtube',
      mediaSourceId: id,
      externalKey: 'aqz-KE-bpKQ',
    }),
  ]);
  if (!saved) {
    throw new Error('Missing saved video');
  }
  expect(ApiProgramConverters.convertProgram(saved, undefined)).toMatchObject({
    type: 'other_video',
    summary: 'An independently stored description.',
    youtubeMetadata: { creatorName: 'Fixture creator' },
  });
  const repeated = await app.inject({
    method: 'POST',
    url: `/api/media-sources/${id}/youtube/import`,
    payload: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  });
  expect(repeated.statusCode, repeated.body).toBe(200);
  expect(repeated.json<{ program: { id: string } }>().program.id).toBe(
    result.program.id,
  );
  expect(await db.query.externalCollectionPrograms.findMany()).toHaveLength(1);
  const source = await app.inject({
    method: 'GET',
    url: `/api/media-sources/${id}`,
  });
  expect(source.statusCode).toBe(200);
  expect(source.json()).toMatchObject({
    type: 'youtube',
    name: 'Video fixture',
    libraries: [
      expect.objectContaining({
        id: result.libraryId,
        mediaType: 'other_videos',
      }),
    ],
  });
  expect(source.json()).not.toHaveProperty('uri');
  expect(source.json()).not.toHaveProperty('accessToken');
  expect(metadata).toHaveBeenCalledTimes(2);
});

test('unsupported and ambiguous inputs do not start extraction or create programmes', async () => {
  const before = metadata.mock.calls.length;
  for (const url of [
    'https://127.0.0.1/watch?v=aqz-KE-bpKQ',
    'https://youtube.com/playlist?list=anything',
    'https://youtube.com/watch?v=aqz-KE-bpKQ&list=anything',
  ]) {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/media-sources/missing/youtube/import',
      payload: { url },
    });
    expect(rejected.statusCode).toBe(400);
  }
  expect(metadata.mock.calls).toHaveLength(before);
});

const a = 'aqz-KE-bpKQ',
  b = 'abcdefghijk',
  c = 'lmnopqrstuv';
const playlistUrl = (id: string) =>
  `https://www.youtube.com/playlist?list=${id}`;
const metadataFor = (id: string): YouTubeVideoMetadata => ({
  id,
  title: `Video ${id}`,
  durationSeconds: 60,
  tags: [],
  creatorName: 'Collection creator',
});
const playlistFor = (
  id: string,
  ids: Array<string | null>,
): YouTubeListing => ({
  kind: 'playlist',
  id,
  title: `Collection ${id}`,
  entries: ids.map((videoId) => ({
    videoId,
    title: videoId ?? 'Deleted entry',
    unavailable: false,
  })),
});
async function newCollectionSource() {
  metadata.mockImplementation((id) => Promise.resolve(metadataFor(id)));
  const response = await app.inject({
    method: 'POST',
    url: '/api/media-sources',
    payload: { type: 'youtube', name: 'Ordered fixture', pathReplacements: [] },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{
    id: MediaSourceId;
    libraries: Array<{ id: string }>;
  }>();
}
async function importLinks(sourceId: string, urls: string[], refresh = false) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/media-sources/${sourceId}/youtube/imports`,
    payload: { inputs: urls.map((url) => ({ url })), refresh },
  });
  expect(response.statusCode, response.body).toBe(200);
  return YouTubeLinksImportResponseSchema.parse(response.json());
}
async function page(sourceId: string, collectionId: string, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/media-sources/${sourceId}/youtube/collections/${collectionId}/entries${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return YouTubeCollectionPageSchema.parse(response.json());
}

test('multi-URL import deduplicates hydration, not playlist occurrences, through persisted pagination and shared catalogue', async () => {
  const source = await newCollectionSource();
  listing.mockImplementation((input) =>
    Promise.resolve(
      playlistFor(input.id, input.id === 'PLone' ? [a, b, a] : [a, c]),
    ),
  );
  const before = metadata.mock.calls.length;
  const result = await importLinks(source.id, [
    `https://youtu.be/${a}`,
    playlistUrl('PLone'),
    playlistUrl('PLtwo'),
    playlistUrl('PLone'),
  ]);
  expect(metadata.mock.calls.length - before).toBe(3);
  expect(result.imports.map((input) => input.status)).toEqual([
    'complete',
    'complete',
    'complete',
    'duplicate',
  ]);
  expect(
    result.imports
      .flatMap((input) => input.entries)
      .map((entry) => entry.videoId),
  ).toEqual([a, a, b, a, a, c]);
  const first = result.imports[1];
  if (!first?.collection) {
    throw new Error('Playlist missing');
  }
  expect(new Set(first.entries.map((entry) => entry.id)).size).toBe(3);
  expect(first.entries[0]?.program?.id).toBe(first.entries[2]?.program?.id);
  const firstCollection = first.collection;
  const pages = await Promise.all(
    [0, 1, 2].map((offset) =>
      page(
        source.id,
        firstCollection.id,
        `?offset=${offset}&limit=1&revision=${firstCollection.revision}`,
      ),
    ),
  );
  expect(
    pages.flatMap((result) => result.entries.map((entry) => entry.id)),
  ).toEqual(first.entries.map((entry) => entry.id));
  expect(pages.map((result) => result.total)).toEqual([3, 3, 3]);
  const db = DBAccess.instance.drizzle;
  if (!db) {
    throw new Error('Database not initialized');
  }
  const programmes = await db.query.program.findMany({
    where: (p, { eq }) => eq(p.mediaSourceId, source.id),
    with: { versions: true },
  });
  expect(programmes).toHaveLength(3);
  expect(programmes.flatMap((program) => program.versions)).toEqual([]);
  const beforeBrowse = metadata.mock.calls.length;
  const collections = await app.inject({
    method: 'GET',
    url: `/api/media-sources/${source.id}/youtube/collections`,
  });
  expect(collections.statusCode).toBe(200);
  expect(collections.json()).toHaveLength(3);
  await page(source.id, first.collection.id);
  expect(metadata.mock.calls).toHaveLength(beforeBrowse);
  const other = await newCollectionSource();
  const foreign = await app.inject({
    method: 'GET',
    url: `/api/media-sources/${other.id}/youtube/collections/${first.collection.id}/entries`,
  });
  expect(foreign.statusCode).toBe(400);
});

test('refresh retains repeated entry identities, safely removes membership and rejects stale page revisions', async () => {
  const source = await newCollectionSource();
  listing.mockResolvedValue(playlistFor('PLrefresh', [a, b, a]));
  const imported = await importLinks(source.id, [playlistUrl('PLrefresh')]);
  const original = imported.imports[0];
  if (!original?.collection) {
    throw new Error('Playlist missing');
  }
  listing.mockResolvedValue(playlistFor('PLrefresh', [b, a, a, c]));
  const refreshed = (
    await importLinks(source.id, [playlistUrl('PLrefresh')], true)
  ).imports[0];
  expect(refreshed?.entries.map((entry) => entry.id)).toEqual([
    original.entries[1]?.id,
    original.entries[0]?.id,
    original.entries[2]?.id,
    expect.any(String),
  ]);
  expect(refreshed?.collection?.id).toBe(original.collection.id);
  expect(refreshed?.changes).toEqual({ added: 1, removed: 0 });
  const stale = await app.inject({
    method: 'GET',
    url: `/api/media-sources/${source.id}/youtube/collections/${original.collection.id}/entries?revision=${original.collection.revision}`,
  });
  expect(stale.statusCode).toBe(409);
  listing.mockResolvedValue(playlistFor('PLrefresh', [b]));
  const removed = await importLinks(
    source.id,
    [playlistUrl('PLrefresh')],
    true,
  );
  expect(removed.imports[0]?.entries.map((entry) => entry.videoId)).toEqual([
    b,
  ]);
  expect(removed.imports[0]?.changes).toEqual({ added: 0, removed: 3 });
  listing.mockResolvedValue(playlistFor('PLrefresh', []));
  const empty = await importLinks(source.id, [playlistUrl('PLrefresh')], true);
  expect(empty.imports[0]).toMatchObject({
    status: 'complete',
    entries: [],
    changes: { added: 0, removed: 1 },
  });
  const db = DBAccess.instance.drizzle;
  if (!db) {
    throw new Error('Database not initialized');
  }
  expect(
    await db.query.program.findMany({
      where: (p, { eq }) => eq(p.mediaSourceId, source.id),
    }),
  ).toHaveLength(3);
});

test('pending/private/unidentified entries stay visible but cannot become zero-duration programmes', async () => {
  const source = await newCollectionSource();
  listing.mockResolvedValue(playlistFor('PLpartial', [a, b, c, null, b]));
  metadata.mockImplementation((id) =>
    id === b
      ? Promise.reject(
          new YouTubeError('PENDING_METADATA', 'Duration not available yet.'),
        )
      : id === c
        ? Promise.reject(new YouTubeError('UNAVAILABLE', 'Private video.'))
        : Promise.resolve(metadataFor(id)),
  );
  const before = metadata.mock.calls.length;
  const result = await importLinks(source.id, [playlistUrl('PLpartial')]);
  expect(result.imports[0]?.entries.map((entry) => entry.status)).toEqual([
    'available',
    'pending',
    'unavailable',
    'unavailable',
    'pending',
  ]);
  expect(
    result.imports[0]?.entries
      .filter((entry) => entry.program)
      .map((entry) => entry.videoId),
  ).toEqual([a]);
  expect(metadata.mock.calls.length - before).toBe(3);
  const collection = result.imports[0]?.collection;
  if (!collection) {
    throw new Error('Partial collection missing');
  }
  expect(
    (await page(source.id, collection.id)).entries.map((entry) => entry.status),
  ).toEqual(['available', 'pending', 'unavailable', 'unavailable', 'pending']);
});

test('transient failure and cancellation after preparation keep the last complete snapshot', async () => {
  const source = await newCollectionSource();
  listing.mockResolvedValue(playlistFor('PLatomic', [a, b, a]));
  const original = (await importLinks(source.id, [playlistUrl('PLatomic')]))
    .imports[0];
  if (!original?.collection) {
    throw new Error('Playlist missing');
  }
  metadata.mockImplementation((id) =>
    id === b
      ? Promise.reject(new YouTubeError('NETWORK', 'Temporary failure.'))
      : Promise.resolve(metadataFor(id)),
  );
  const failed = await importLinks(source.id, [playlistUrl('PLatomic')], true);
  expect(failed.imports[0]?.status).toBe('failed');
  let retained = await page(source.id, original.collection.id);
  expect(retained.collection.revision).toBe(original.collection.revision);
  expect(retained.collection.lastSuccessfulRefreshAt).toBe(
    original.collection.lastSuccessfulRefreshAt,
  );
  expect(retained.collection.lastRefreshError).toBe('Temporary failure.');
  expect(retained.entries.map((entry) => entry.id)).toEqual(
    original.entries.map((entry) => entry.id),
  );
  let markStarted: (signal: AbortSignal) => void = () => {
    throw new Error('Not initialized');
  };
  const started = new Promise<AbortSignal>((resolve) => {
    markStarted = resolve;
  });
  metadata.mockImplementation((id, signal) =>
    id === b
      ? new Promise((_resolve, reject) => {
          markStarted(signal);
          signal.addEventListener(
            'abort',
            () => reject(new Error('Cancelled metadata')),
            { once: true },
          );
        })
      : Promise.resolve(metadataFor(id)),
  );
  const owner = new AbortController();
  const operation = container
    .get(MediaSourceScanCoordinator)
    .importYouTubeLinks(
      source.id,
      [{ url: playlistUrl('PLatomic'), order: 'newest' }],
      owner.signal,
      true,
    );
  const rejection = expect(operation).rejects.toThrow();
  const activeSignal = await started;
  owner.abort();
  await rejection;
  expect(activeSignal.aborted).toBe(true);
  retained = await page(source.id, original.collection.id);
  expect(retained.collection.revision).toBe(original.collection.revision);
  expect(retained.entries.map((entry) => entry.id)).toEqual(
    original.entries.map((entry) => entry.id),
  );
});

test('canonical creator uploads retain identity across input aliases and expose explicit reversed page ordering', async () => {
  const source = await newCollectionSource();
  const channel = 'UCSMOQeBJ2RAnuFungnQOxLg';
  listing.mockResolvedValue({
    ...playlistFor(channel, [a, b, c]),
    kind: 'creator_uploads',
  });
  const result = await importLinks(source.id, [
    'https://www.youtube.com/@BlenderOfficial',
    `https://www.youtube.com/channel/${channel}`,
  ]);
  expect(result.imports.map((input) => input.status)).toEqual([
    'complete',
    'duplicate',
  ]);
  const collection = result.imports[0]?.collection;
  if (!collection) {
    throw new Error('Creator collection missing');
  }
  expect(collection.externalKey).toBe(`creator:${channel}`);
  expect(
    (await page(source.id, collection.id, '?order=oldest&limit=2')).entries.map(
      (entry) => entry.videoId,
    ),
  ).toEqual([c, b]);
  expect(
    (
      await page(source.id, collection.id, '?order=oldest&offset=2&limit=2')
    ).entries.map((entry) => entry.videoId),
  ).toEqual([a]);
});
