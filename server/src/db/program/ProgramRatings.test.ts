import { tag } from '@tunarr/types';
import type { Movie, Show } from '@tunarr/types';
import { ratingFieldKey } from '@tunarr/shared/util';
import {
  Movie as MovieSchema,
  Show as ShowSchema,
} from '@tunarr/types/schemas';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import { test as baseTest, describe, expect } from 'vitest';
import { bootstrapTunarr } from '../../bootstrap.ts';
import { ApiProgramConverters } from '../../api/ApiProgramConverters.ts';
import { extractPlexRatings } from '../../external/plex/plexRatings.ts';
import { globalOptions, setGlobalOptions } from '../../globals.ts';
import { FileSystemService } from '../../services/FileSystemService.ts';
import { copyPreMigratedDb } from '../../testing/testDbFactory.ts';
import { DBAccess } from '../DBAccess.ts';
import { ProgramDaoMinter } from '../converters/ProgramMinter.ts';
import { ProgramGroupingMinter } from '../converters/ProgramGroupingMinter.ts';
import type { DrizzleDBAccess } from '../schema/index.ts';
import { MediaSource } from '../schema/MediaSource.ts';
import { MediaSourceLibrary } from '../schema/MediaSourceLibrary.ts';
import { Program } from '../schema/Program.ts';
import { ProgramGrouping } from '../schema/ProgramGrouping.ts';
import { RatingField } from '../schema/RatingField.ts';
import { ProgramExternalIdRepository } from './ProgramExternalIdRepository.ts';
import { ProgramGroupingUpsertRepository } from './ProgramGroupingUpsertRepository.ts';
import { ProgramMetadataRepository } from './ProgramMetadataRepository.ts';
import { ProgramUpsertRepository } from './ProgramUpsertRepository.ts';

const test = baseTest.extend<{ drizzle: DrizzleDBAccess }>({
  drizzle: async ({}, use) => {
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

function fixtures(db: DrizzleDBAccess) {
  const source = db
    .insert(MediaSource)
    .values({
      uuid: tag(v4()),
      name: tag('Ratings fixture ' + v4()),
      type: 'plex',
      uri: 'http://plex.invalid',
      accessToken: 'fixture-only',
      index: 0,
      sendChannelUpdates: false,
      sendGuideUpdates: false,
    })
    .returning()
    .get();
  const library = db
    .insert(MediaSourceLibrary)
    .values({
      uuid: v4(),
      name: 'Fixture',
      mediaSourceId: source.uuid,
      mediaType: 'movies',
      externalKey: '1',
      enabled: true,
    })
    .returning()
    .get();
  const parsed = extractPlexRatings({ rating: 7, userRating: 0 }, 100);
  if (!parsed.snapshot) throw new Error('Invalid fixture snapshot');
  const common = {
    uuid: v4(),
    externalId: v4(),
    canonicalId: v4(),
    mediaSourceId: source.uuid,
    libraryId: library.uuid,
    sourceType: 'plex' as const,
    title: 'Fixture title',
    sortTitle: 'Fixture title',
    year: 2009,
    releaseDate: null,
    releaseDateString: null,
    summary: null,
    plot: null,
    tagline: null,
    genres: [],
    actors: [],
    writers: [],
    directors: [],
    studios: [],
    artwork: [],
    tags: [],
    identifiers: [],
    ratings: parsed.snapshot,
  };
  const metadata = new ProgramMetadataRepository(
    db,
    new FileSystemService(globalOptions()),
  );
  const kysely = DBAccess.instance.db;
  if (!kysely) throw new Error('Fixture database not initialized');
  const programs = new ProgramUpsertRepository(
    db,
    new ProgramExternalIdRepository(kysely, db),
    metadata,
  );
  const groupings = new ProgramGroupingUpsertRepository(kysely, db, metadata);
  return {
    source: { ...source, libraries: [library], paths: [], replacePaths: [] },
    library,
    common,
    programs,
    groupings,
  };
}

describe('Plex numeric ratings persistence', () => {
  test('mints, upserts and serializes scores without changing content ratings or losing omitted snapshots', async ({
    drizzle,
  }) => {
    const { source, library, common, programs } = fixtures(drizzle);
    const movie: Movie = {
      ...common,
      type: 'movie',
      originalTitle: null,
      rating: 'PG-13',
      duration: 12345,
      state: 'ok',
    };
    const minter = new ProgramDaoMinter();
    const first = await programs.upsertPrograms(
      minter.mintMovie(source, library, movie),
    );
    expect(first.ratings).toEqual(movie.ratings);
    expect(first.rating).toBe('PG-13');
    const saved = await programs.upsertPrograms(
      minter.mintMovie(source, library, { ...movie, ratings: undefined }),
    );
    expect(saved.uuid).toBe(first.uuid);
    expect(saved.ratings).toEqual(movie.ratings);
    expect(saved.duration).toBe(12345);
    const row = drizzle
      .select()
      .from(Program)
      .all()
      .find((p) => p.uuid === first.uuid);
    if (!row) throw new Error('Program not persisted');
    const dto = MovieSchema.parse(
      ApiProgramConverters.convertProgram(
        { ...row, externalIds: [] },
        undefined,
      ),
    );
    expect(dto.ratings).toEqual(movie.ratings);
    expect(dto.omnirating).toBe(70);
    expect(dto.rating).toBe('PG-13');
    const empty = { version: 1 as const, observedAt: 200, entries: [] };
    const cleared = await programs.upsertPrograms(
      minter.mintMovie(source, library, { ...movie, ratings: empty }),
    );
    expect(cleared.uuid).toBe(first.uuid);
    expect(cleared.ratings).toEqual(empty);
    expect(
      drizzle
        .select()
        .from(RatingField)
        .all()
        .map((f) => f.key),
    ).toContain(ratingFieldKey('plex', 'primary'));
  });

  test('updates a grouping score even when the media version is unchanged, and retains its stable catalog keys', async ({
    drizzle,
  }) => {
    const { source, library, common, groupings } = fixtures(drizzle);
    const show: Show = {
      ...common,
      type: 'show',
      rating: 'TV-PG',
      identifiers: [
        { type: 'plex', id: common.externalId, sourceId: source.uuid },
      ],
    };
    const minter = new ProgramGroupingMinter();
    const first = await groupings.upsertProgramGrouping(
      minter.mintForMediaSourceShow(source, library, show),
    );
    const nextSnapshot = extractPlexRatings({ rating: 8 }, 300).snapshot;
    if (!nextSnapshot) throw new Error('Invalid fixture');
    const updated = await groupings.upsertProgramGrouping(
      minter.mintForMediaSourceShow(source, library, {
        ...show,
        ratings: nextSnapshot,
      }),
    );
    expect(updated.entity.uuid).toBe(first.entity.uuid);
    expect(updated.entity.ratings).toEqual(nextSnapshot);
    const preserved = await groupings.upsertProgramGrouping(
      minter.mintForMediaSourceShow(source, library, {
        ...show,
        ratings: undefined,
      }),
    );
    expect(preserved.entity.ratings).toEqual(nextSnapshot);
    const row = drizzle
      .select()
      .from(ProgramGrouping)
      .all()
      .find((p) => p.uuid === first.entity.uuid);
    if (!row) throw new Error('Grouping not persisted');
    const dto = ShowSchema.parse(
      ApiProgramConverters.convertProgramGrouping(
        { ...row, externalIds: [] },
        undefined,
        undefined,
        source,
        library,
      ),
    );
    expect(dto.omnirating).toBe(80);
    expect(dto.rating).toBe('TV-PG');
    expect(dto.ratings?.entries).toHaveLength(1);
  });
});
