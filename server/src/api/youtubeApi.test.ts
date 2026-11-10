import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { container } from '../container.ts';
import { DBAccess } from '../db/DBAccess.ts';
import { YouTubeAdapter } from '../external/youtube/YouTubeAdapter.ts';
import { MeilisearchService } from '../services/MeilisearchService.ts';
import { getAvailablePort } from '../util/net.ts';
import { initTestApp, dbResult } from '../../tests/testServer.ts';
import { ApiProgramConverters } from './ApiProgramConverters.ts';

let app: FastifyInstance;
let metadata: MockInstance<YouTubeAdapter['metadata']>;

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
