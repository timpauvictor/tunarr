import { tag } from '@tunarr/types';
import { calculateOmnirating } from '@tunarr/shared/util';
import type { RatingSnapshot } from '@tunarr/types/schemas';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import { test as baseTest, describe, expect, vi } from 'vitest';
import { bootstrapTunarr } from '../../bootstrap.ts';
import { DBAccess } from '../../db/DBAccess.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.ts';
import { MediaSource } from '../../db/schema/MediaSource.ts';
import { MediaSourceLibrary } from '../../db/schema/MediaSourceLibrary.ts';
import { Program } from '../../db/schema/Program.ts';
import { ProgramGrouping } from '../../db/schema/ProgramGrouping.ts';
import { BaseApiClient } from '../../external/BaseApiClient.ts';
import { setGlobalOptions } from '../../globals.ts';
import { copyPreMigratedDb } from '../../testing/testDbFactory.ts';
import { PlexRatingsRefreshService } from './PlexRatingsRefreshService.ts';
import { MediaSourceScanCoordinator } from './MediaSourceScanCoordinator.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import { EntityMutex } from '../EntityMutex.ts';
import { MutexMap } from '../../util/mutexMap.ts';

// The ratings coordinator must never enter the full-scan/task graph. Keep
// those unrelated runtime factories out of this focused transport/DB fixture.
vi.mock('../../tasks/ReconcileProgramDurationsTask.ts', () => ({
  ReconcileProgramDurationsTask: class ReconcileProgramDurationsTask {},
}));
vi.mock('../Scheduler.ts', () => ({ GlobalScheduler: { runTask: vi.fn() } }));

class FixtureClient extends BaseApiClient {}
const oldRatings: RatingSnapshot = {
  version: 1,
  observedAt: 100,
  entries: [
    { providerId: 'plex', kind: 'primary', value: 2, scale: 10, score: 20 },
  ],
};
const test = baseTest.extend<{ db: DrizzleDBAccess }>({
  db: async ({}, use) => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    try {
      await copyPreMigratedDb(dir.path);
      setGlobalOptions({ database: dir.path, log_level: 'warn', verbose: 0 });
      await bootstrapTunarr();
      const db = DBAccess.instance.drizzle;
      if (!db) throw new Error('Fixture database not initialized');
      await use(db);
    } finally {
      await dir.cleanup();
    }
  },
});

async function fixture(db: DrizzleDBAccess) {
  const metadata = new Map<string, Record<string, unknown>>();
  const paths: string[] = [];
  let active = 0,
    maximumActive = 0;
  let override:
    | ((key: string, req: IncomingMessage, res: ServerResponse) => boolean)
    | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://fixture').pathname;
    paths.push(pathname);
    const key = pathname.split('/').at(-1) ?? '';
    active++;
    maximumActive = Math.max(maximumActive, active);
    let closed = false;
    const finished = () => {
      if (!closed) {
        active--;
        closed = true;
      }
    };
    res.once('close', finished);
    res.once('finish', finished);
    if (override?.(key, req, res)) return;
    if (!pathname.startsWith('/library/metadata/') || !metadata.has(key)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          MediaContainer: { size: 1, Metadata: [metadata.get(key)] },
        }),
      );
    }, 5);
    timers.add(timer);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const source = db
    .insert(MediaSource)
    .values({
      uuid: tag(v4()),
      name: tag('Ratings fixture ' + v4()),
      type: 'plex',
      uri: `http://127.0.0.1:${address.port}/`,
      accessToken: 'fixture-credential',
      index: 0,
      sendChannelUpdates: false,
      sendGuideUpdates: false,
    })
    .returning()
    .get();
  const libraryValues = [
    { name: 'Movies', mediaType: 'movies' as const, externalKey: '1' },
    { name: 'TV', mediaType: 'shows' as const, externalKey: '2' },
    { name: 'Music', mediaType: 'tracks' as const, externalKey: '3' },
    { name: 'Clips', mediaType: 'other_videos' as const, externalKey: '4' },
  ];
  const libraries = libraryValues.map((value) =>
    db
      .insert(MediaSourceLibrary)
      .values({
        ...value,
        uuid: v4(),
        mediaSourceId: source.uuid,
        enabled: true,
        lastScannedAt: new Date(0),
      })
      .returning()
      .get(),
  );
  const libraryFor = (key: string) => {
    const library = libraries.find((library) => library.externalKey === key);
    if (!library) throw new Error('Missing fixture library');
    return library;
  };
  const loadLibrary = async (key = '1') => {
    const library = await db.query.mediaSourceLibrary.findFirst({
      where: eq(MediaSourceLibrary.uuid, libraryFor(key).uuid),
      with: {
        mediaSource: {
          with: { libraries: true, paths: true, replacePaths: true },
        },
      },
    });
    if (!library) throw new Error('Missing fixture library');
    return library;
  };
  const group = (
    key: string,
    type: 'show' | 'season' | 'artist' | 'album',
    lib: string,
    parents: { showUuid?: string; artistUuid?: string } = {},
  ) =>
    db
      .insert(ProgramGrouping)
      .values({
        uuid: v4(),
        canonicalId: 'fixture-' + key,
        title: 'Grouping ' + key,
        type,
        sourceType: 'plex',
        mediaSourceId: source.uuid,
        libraryId: libraryFor(lib).uuid,
        externalKey: key,
        ratings: oldRatings,
        rating: type === 'show' ? 'TV-PG' : null,
        ...parents,
      })
      .returning()
      .get();
  const show = group('201', 'show', '2');
  const season = group('202', 'season', '2', { showUuid: show.uuid });
  const artist = group('301', 'artist', '3');
  const album = group('302', 'album', '3', { artistUuid: artist.uuid });
  const program = (
    key: string,
    type: 'movie' | 'episode' | 'track' | 'other_video',
    lib: string,
    parents: {
      tvShowUuid?: string;
      seasonUuid?: string;
      artistUuid?: string;
      albumUuid?: string;
    } = {},
  ) =>
    db
      .insert(Program)
      .values({
        uuid: v4(),
        canonicalId: 'fixture-' + key,
        title: 'Program ' + key,
        duration: 12345,
        type,
        sourceType: 'plex',
        externalSourceId: source.name,
        mediaSourceId: source.uuid,
        libraryId: libraryFor(lib).uuid,
        externalKey: key,
        ratings: oldRatings,
        rating: 'PG-13',
        ...parents,
      })
      .returning()
      .get();
  program('101', 'movie', '1');
  program('102', 'movie', '1');
  program('203', 'episode', '2', {
    tvShowUuid: show.uuid,
    seasonUuid: season.uuid,
  });
  program('303', 'track', '3', {
    artistUuid: artist.uuid,
    albumUuid: album.uuid,
  });
  program('401', 'other_video', '4');
  const reviews = (values: number[]) =>
    values.map((value, index) => ({
      image: [
        'imdb://image.rating',
        'rottentomatoes://image.rating.ripe',
        'rottentomatoes://image.rating.upright',
        'themoviedb://image.rating',
      ][index],
      type: index === 1 ? 'critic' : 'audience',
      value,
    }));
  for (const [key, type, lib] of [
    ['101', 'movie', 1],
    ['102', 'movie', 1],
    ['201', 'show', 2],
    ['202', 'season', 2],
    ['203', 'episode', 2],
    ['301', 'artist', 3],
    ['302', 'album', 3],
    ['303', 'track', 3],
    ['401', 'movie', 4],
  ] as const)
    metadata.set(key, {
      ratingKey: key,
      type,
      librarySectionID: lib,
      title: 'Fixture ' + key,
    });
  metadata.set('101', {
    ...metadata.get('101'),
    audienceRating: 6,
    audienceRatingImage: 'imdb://image.rating',
    userRating: 8,
    Rating: reviews([6, 3.6, 5, 6.5]),
  });
  metadata.set('201', {
    ...metadata.get('201'),
    Rating: reviews([7.8, 8.6, 7.2, 8.2]),
  });
  metadata.set('203', {
    ...metadata.get('203'),
    Rating: [
      { image: 'themoviedb://image.rating', type: 'audience', value: 6.9 },
    ],
  });
  metadata.set('302', { ...metadata.get('302'), rating: 7 });
  metadata.set('303', {
    ...metadata.get('303'),
    ratingCount: 10537,
    userRating: 0,
  });
  metadata.set('401', { ...metadata.get('401'), subtype: 'clip', rating: 8 });
  const indexed: { id: string; ratings: RatingSnapshot }[] = [];
  const updateRatings = vi.fn(
    async (updates: { id: string; ratings: RatingSnapshot }[]) => {
      indexed.push(...updates);
      return { indexed: updates.length, unindexed: 0 };
    },
  );
  const service = new PlexRatingsRefreshService(
    db,
    () => ({
      getPlexApiClientForMediaSource: async (
        mediaSource: MediaSourceWithRelations,
      ) =>
        new FixtureClient({
          mediaSource,
          extraHeaders: { 'X-Plex-Token': mediaSource.accessToken },
        }),
    }),
    { updateRatings },
  );
  const run = async (lib = '1', signal = new AbortController().signal) => {
    const library = await loadLibrary(lib);
    const job = service.queue(library.uuid, source.uuid);
    await service.run(job.jobId, library, signal, () => {});
    return service.getStatus(library.uuid);
  };
  return {
    source,
    libraries,
    loadLibrary,
    service,
    indexed,
    updateRatings,
    metadata,
    paths,
    run,
    maximum: () => maximumActive,
    setHandler: (handler: typeof override) => {
      override = handler;
    },
    rows: () => [
      ...db
        .select()
        .from(Program)
        .where(eq(Program.mediaSourceId, source.uuid))
        .all(),
      ...db
        .select()
        .from(ProgramGrouping)
        .where(eq(ProgramGrouping.mediaSourceId, source.uuid))
        .all(),
    ],
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Plex ratings-only refresh', () => {
  test('updates all supported entity families through bounded metadata requests, changing only rating snapshots', async ({
    db,
  }) => {
    const f = await fixture(db);
    try {
      const before = f.rows();
      for (const library of ['1', '2', '3', '4'])
        expect(await f.run(library)).toMatchObject({
          state: 'completed',
          failed: 0,
          skipped: 0,
          indexFailed: 0,
        });
      const after = f.rows();
      const expected = new Map([
        ['101', 52.75],
        ['102', null],
        ['201', 79.5],
        ['202', null],
        ['203', 69],
        ['301', null],
        ['302', 70],
        ['303', null],
        ['401', 80],
      ]);
      for (const row of after) {
        const previous = before.find((item) => item.uuid === row.uuid);
        expect({ ...row, ratings: previous?.ratings }).toEqual(previous);
        expect(calculateOmnirating(row.ratings)).toBe(
          expected.get(row.externalKey ?? ''),
        );
      }
      expect(
        after.find((row) => row.externalKey === '303')?.ratings?.entries,
      ).toEqual([
        { providerId: 'plex', kind: 'personal', value: 0, scale: 10, score: 0 },
      ]);
      expect(f.indexed).toHaveLength(9);
      expect(f.paths).toHaveLength(9);
      expect(
        f.paths.every((path) => path.startsWith('/library/metadata/')),
      ).toBe(true);
      expect(f.maximum()).toBe(2);
      expect(
        db
          .select()
          .from(MediaSource)
          .where(eq(MediaSource.uuid, f.source.uuid))
          .get(),
      ).toEqual(f.source);
      expect(
        db
          .select()
          .from(MediaSourceLibrary)
          .where(eq(MediaSourceLibrary.mediaSourceId, f.source.uuid))
          .all(),
      ).toEqual(f.libraries);
    } finally {
      await f.close();
    }
  });

  test('retains denied, unavailable and malformed item scores while other items succeed', async ({
    db,
  }) => {
    for (const mode of ['404', '403', 'malformed', 'wrong_identity'] as const) {
      const f = await fixture(db);
      try {
        if (mode === '404' || mode === '403')
          f.setHandler((key, _req, res) => {
            if (key !== '101') return false;
            res.statusCode = Number(mode);
            res.end();
            return true;
          });
        else
          f.metadata.set(
            '101',
            mode === 'malformed'
              ? { ...f.metadata.get('101'), Rating: 'broken' }
              : { ...f.metadata.get('101'), ratingKey: 'different-item' },
          );
        expect(await f.run(), mode).toMatchObject({
          state: 'partial',
          total: 2,
          processed: 2,
          refreshed: 1,
          failed: 1,
        });
        expect(
          f.rows().find((row) => row.externalKey === '101')?.ratings,
        ).toEqual(oldRatings);
        expect(
          f.rows().find((row) => row.externalKey === '102')?.ratings?.entries,
        ).toEqual([]);
      } finally {
        await f.close();
      }
    }
  });

  test('stops an authentication failure before starting more metadata work', async ({
    db,
  }) => {
    const f = await fixture(db);
    try {
      const original = db
        .select()
        .from(Program)
        .where(eq(Program.mediaSourceId, f.source.uuid))
        .all()
        .find((row) => row.externalKey === '101');
      if (!original) throw new Error('Missing fixture program');
      db.insert(Program)
        .values({
          ...original,
          uuid: v4(),
          externalKey: '103',
          canonicalId: 'fixture-103',
        })
        .run();
      f.setHandler((_key, _req, res) => {
        res.statusCode = 401;
        res.end();
        return true;
      });
      expect(await f.run()).toMatchObject({
        state: 'failed',
        total: 3,
        lastError: 'auth',
        refreshed: 0,
      });
      expect(f.paths.length).toBeLessThanOrEqual(2);
      expect(
        f
          .rows()
          .every(
            (row) => JSON.stringify(row.ratings) === JSON.stringify(oldRatings),
          ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  test('owns queue cancellation by job identity, releases locks and never invokes a full scan or duration reconciliation', async ({
    db,
  }) => {
    const f = await fixture(db);
    const mutex = new EntityMutex(new MutexMap());
    const progress = new MediaSourceProgressService();
    const scannerFactory = vi.fn(() => {
      throw new Error('Unexpected full scan');
    });
    const localFactory = vi.fn(() => {
      throw new Error('Unexpected local scan');
    });
    const reconcileFactory = vi.fn(() => {
      throw new Error('Unexpected duration reconciliation');
    });
    const coordinator = new MediaSourceScanCoordinator(
      {
        getById: async () => undefined,
        getLibrary: async (id) => {
          const entry = f.libraries.find((library) => library.uuid === id);
          return entry ? f.loadLibrary(entry.externalKey) : undefined;
        },
      },
      mutex,
      scannerFactory,
      localFactory,
      progress,
      () => undefined,
      reconcileFactory,
      f.service,
      {
        importVideo: () =>
          Promise.reject(
            new Error('Unexpected YouTube import in a ratings fixture'),
          ),
        refresh: () =>
          Promise.reject(
            new Error('Unexpected YouTube refresh in a ratings fixture'),
          ),
      },
    );
    try {
      f.setHandler((key, _req, _res) => key === '101');
      const movieLibrary = await f.loadLibrary('1');
      const tvLibrary = await f.loadLibrary('2');
      const releaseSource = await (
        await mutex.getLockForMediaSource(f.source)
      ).acquire();
      try {
        expect(
          await coordinator.addRatingsRefresh(f.source.uuid, movieLibrary.uuid),
        ).toBeNull();
        expect(mutex.isLibraryLocked(movieLibrary)).toBe(false);
      } finally {
        releaseSource();
      }
      const active = await coordinator.addRatingsRefresh(
        f.source.uuid,
        movieLibrary.uuid,
      );
      if (!active) throw new Error('Movie job not admitted');
      await vi.waitFor(() =>
        expect(f.paths).toContain('/library/metadata/101'),
      );
      expect(progress.getScanProgress(movieLibrary.uuid)).toMatchObject({
        state: 'in_progress',
        operation: 'ratings',
      });
      expect(
        await coordinator.addRatingsRefresh(f.source.uuid, movieLibrary.uuid),
      ).toBeNull();
      const queued = await coordinator.addRatingsRefresh(
        f.source.uuid,
        tvLibrary.uuid,
      );
      if (!queued) throw new Error('TV job not admitted');
      expect(f.service.getStatus(tvLibrary.uuid)?.state).toBe('queued');
      expect(progress.getScanProgress(tvLibrary.uuid)).toMatchObject({
        state: 'queued',
        operation: 'ratings',
      });
      expect(
        coordinator.cancelRatingsRefresh(tvLibrary.uuid, queued.jobId),
      ).toBe(true);
      expect(f.service.getStatus(tvLibrary.uuid)?.state).toBe('cancelled');
      expect(mutex.isLibraryLocked(tvLibrary)).toBe(false);
      const replacement = await coordinator.addRatingsRefresh(
        f.source.uuid,
        tvLibrary.uuid,
      );
      if (!replacement) throw new Error('Replacement not admitted');
      expect(replacement.jobId).not.toBe(queued.jobId);
      expect(
        coordinator.cancelRatingsRefresh(tvLibrary.uuid, queued.jobId),
      ).toBe(false);
      expect(
        coordinator.cancelRatingsRefresh(movieLibrary.uuid, active.jobId),
      ).toBe(true);
      await coordinator.awaitAllFinished();
      expect(f.service.getStatus(tvLibrary.uuid)?.state).toBe('completed');
      expect(f.service.getStatus(movieLibrary.uuid)?.state).toBe('cancelled');
      expect(mutex.isLibraryLocked(movieLibrary)).toBe(false);
      expect(mutex.isLibraryLocked(tvLibrary)).toBe(false);
      expect(progress.getScanProgress(tvLibrary.uuid)).toEqual({
        state: 'not_scanning',
      });
      expect(
        f.paths.filter((path) =>
          [
            '/library/metadata/201',
            '/library/metadata/202',
            '/library/metadata/203',
          ].includes(path),
        ),
      ).toHaveLength(3);
      expect(scannerFactory).not.toHaveBeenCalled();
      expect(localFactory).not.toHaveBeenCalled();
      expect(reconcileFactory).not.toHaveBeenCalled();
    } finally {
      coordinator.cancelAll();
      await coordinator.awaitAllFinished();
      await f.close();
    }
  });

  test('aborts active HTTP work on cancellation without erasing prior scores', async ({
    db,
  }) => {
    const f = await fixture(db);
    const controller = new AbortController();
    let closed = false;
    try {
      f.setHandler((key, _req, res) => {
        if (key !== '101') return false;
        res.once('close', () => {
          closed = true;
        });
        return true;
      });
      const pending = f.run('1', controller.signal);
      await vi.waitFor(() =>
        expect(f.paths).toContain('/library/metadata/101'),
      );
      controller.abort();
      expect(await pending).toMatchObject({
        state: 'cancelled',
        cancelRequested: true,
      });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(
        f.rows().find((row) => row.externalKey === '101')?.ratings,
      ).toEqual(oldRatings);
      expect(
        f.indexed.some(
          (row) =>
            row.id === f.rows().find((row) => row.externalKey === '101')?.uuid,
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test('enforces a real ten-second request deadline and retains unavailable metadata', async ({
    db,
  }) => {
    const f = await fixture(db);
    let closed = false;
    try {
      f.setHandler((key, _req, res) => {
        if (key !== '101') return false;
        res.once('close', () => {
          closed = true;
        });
        return true;
      });
      expect(await f.run()).toMatchObject({
        state: 'partial',
        failed: 1,
        lastError: 'timeout',
      });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(
        f.rows().find((row) => row.externalKey === '101')?.ratings,
      ).toEqual(oldRatings);
    } finally {
      await f.close();
    }
  }, 15_000);

  test('rejects a changed source account before committing a fetched response', async ({
    db,
  }) => {
    const f = await fixture(db);
    try {
      f.setHandler((_key, _req, _res) => {
        db.update(MediaSource)
          .set({ accessToken: 'changed-fixture-account' })
          .where(eq(MediaSource.uuid, f.source.uuid))
          .run();
        return false;
      });
      expect(await f.run()).toMatchObject({
        state: 'failed',
        lastError: 'source_changed',
        refreshed: 0,
      });
      expect(
        f
          .rows()
          .every(
            (row) => JSON.stringify(row.ratings) === JSON.stringify(oldRatings),
          ),
      ).toBe(true);
      expect(f.indexed).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test('reports unconfirmed indexing and explicitly resumes without duplicate entities or metadata discovery', async ({
    db,
  }) => {
    const f = await fixture(db);
    try {
      f.updateRatings.mockResolvedValueOnce({ indexed: 1, unindexed: 1 });
      const ids = f.rows().map((row) => row.uuid);
      expect(await f.run()).toMatchObject({
        state: 'partial',
        refreshed: 2,
        indexFailed: 1,
        lastError: 'index',
      });
      expect(await f.run()).toMatchObject({
        state: 'completed',
        refreshed: 0,
        unchanged: 2,
        indexFailed: 0,
      });
      expect(f.rows().map((row) => row.uuid)).toEqual(ids);
      expect(f.paths).toHaveLength(4);
    } finally {
      await f.close();
    }
  });
});
