import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { OtherVideo } from '@tunarr/types/schemas';
import type { YouTubeImportResponse } from '@tunarr/types/schemas';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import { ProgramDaoMinter } from '../db/converters/ProgramMinter.ts';
import { ProgramConverter } from '../db/converters/ProgramConverter.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import type { MediaSourceLibrary } from '../db/schema/MediaSourceLibrary.ts';
import { MediaSourceLibrary as LibraryTable } from '../db/schema/MediaSourceLibrary.ts';
import { Program } from '../db/schema/Program.ts';
import {
  ExternalCollection,
  ExternalCollectionPrograms,
} from '../db/schema/ExternalCollection.ts';
import type { ProgramUpsertRepository } from '../db/program/ProgramUpsertRepository.ts';
import {
  YouTubeAdapter,
  YouTubeError,
} from '../external/youtube/YouTubeAdapter.ts';
import { KEYS } from '../types/inject.ts';
import { MeilisearchService } from './MeilisearchService.ts';

@injectable()
export class YouTubeImportService {
  constructor(
    @inject(YouTubeAdapter) private adapter: YouTubeAdapter,
    @inject(MediaSourceDB) private sources: MediaSourceDB,
    @inject(KEYS.DrizzleDB) private db: DrizzleDBAccess,
    @inject(ProgramDaoMinter) private minter: ProgramDaoMinter,
    @inject(KEYS.ProgramUpsertRepository)
    private programs: ProgramUpsertRepository,
    @inject(ProgramConverter) private converter: ProgramConverter,
    @inject(MeilisearchService) private search: MeilisearchService,
  ) {}

  async importVideo(
    library: MediaSourceLibrary,
    videoId: string,
    signal: AbortSignal,
  ): Promise<YouTubeImportResponse> {
    const metadata = await this.adapter.metadata(videoId, signal);
    signal.throwIfAborted();
    const source = await this.sources.getById(library.mediaSourceId);
    const currentLibrary = await this.sources.getLibrary(library.uuid);
    if (
      !source ||
      source.type !== 'youtube' ||
      !currentLibrary ||
      currentLibrary.mediaSourceId !== source.uuid ||
      !currentLibrary.enabled ||
      currentLibrary.unavailableSince
    ) {
      throw new YouTubeError(
        'UNSUPPORTED_VIDEO',
        'YouTube source or library is no longer available.',
      );
    }
    const previous = await this.db.query.program.findFirst({
      where: (p, { and, eq }) =>
        and(eq(p.mediaSourceId, source.uuid), eq(p.externalKey, metadata.id)),
      with: {
        artwork: true,
        tags: { with: { tag: true } },
        genres: { with: { genre: true } },
      },
    });
    signal.throwIfAborted();
    const durationMs = Math.round(metadata.durationSeconds * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new YouTubeError(
        'UNSUPPORTED_VIDEO',
        'The video has no finite positive scheduling duration.',
      );
    }
    const date = metadata.uploadDate;
    const publicationDate = date
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : undefined;
    const timestamp = publicationDate ? Date.parse(publicationDate) : undefined;
    if (
      timestamp !== undefined &&
      (!Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== publicationDate)
    ) {
      throw new YouTubeError(
        'INVALID_METADATA',
        'YouTube returned an invalid publication date.',
      );
    }
    const video = OtherVideo.parse({
      uuid: previous?.uuid ?? randomUUID(),
      sourceType: 'youtube',
      type: 'other_video',
      mediaSourceId: source.uuid,
      libraryId: library.uuid,
      canonicalId: `youtube|${source.uuid}|${metadata.id}`,
      externalId: metadata.id,
      identifiers: [{ type: 'youtube', id: metadata.id }],
      title: metadata.title,
      sortTitle: metadata.title,
      originalTitle: null,
      duration: durationMs,
      summary: metadata.description ?? previous?.summary ?? null,
      year:
        timestamp !== undefined
          ? new Date(timestamp).getUTCFullYear()
          : (previous?.year ?? null),
      releaseDate:
        timestamp ??
        (previous?.originalAirDate
          ? Date.parse(previous.originalAirDate)
          : null),
      releaseDateString: publicationDate ?? previous?.originalAirDate ?? null,
      youtubeMetadata: {
        creatorId: metadata.creatorId ?? previous?.youtubeMetadata?.creatorId,
        creatorName:
          metadata.creatorName ?? previous?.youtubeMetadata?.creatorName,
      },
      artwork: metadata.thumbnail
        ? [{ type: 'thumbnail', path: metadata.thumbnail }]
        : (previous?.artwork ?? []).map((art) => ({
            type: art.artworkType,
            path: art.sourcePath,
          })),
      tags: metadata.tags.length
        ? metadata.tags
        : (previous?.tags ?? []).map((t) => t.tag.tag),
      genres: metadata.categories?.length
        ? metadata.categories.map((name) => ({ name }))
        : (previous?.genres ?? []).map((g) => ({ name: g.genre.name })),
      state: 'ok',
    });
    signal.throwIfAborted();
    // The existing upsert owns program identity and all normal metadata joins.
    // No media item/version or signed format URL is supplied.
    const saved = await this.programs.upsertPrograms(
      this.minter.mintOtherVideo(source, currentLibrary, {
        ...video,
        sourceType: 'youtube',
      }),
    );
    this.db.transaction((tx) => {
      const collection = tx
        .select()
        .from(ExternalCollection)
        .where(
          and(
            eq(ExternalCollection.mediaSourceId, source.uuid),
            eq(ExternalCollection.externalKey, 'saved-videos'),
          ),
        )
        .get();
      if (!collection) {
        throw new Error('The YouTube Saved Videos collection is missing.');
      }
      tx.insert(ExternalCollectionPrograms)
        .values({ collectionId: collection.uuid, programId: saved.uuid })
        .onConflictDoNothing()
        .run();
      tx.update(LibraryTable)
        .set({ lastScannedAt: new Date() })
        .where(eq(LibraryTable.uuid, library.uuid))
        .run();
    });
    const materialized = { ...video, uuid: saved.uuid };
    const tasks = await this.search.indexOtherVideo([materialized]);
    const indexSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    for (const task of tasks ?? []) {
      await this.search.waitForTaskResult(task.taskUid, false, indexSignal);
    }
    return {
      sourceId: source.uuid,
      libraryId: library.uuid,
      program: this.converter.materializedProgramToContentProgram(materialized),
    };
  }

  async refresh(
    library: MediaSourceLibrary,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<void> {
    const videos = await this.db
      .select({ id: Program.externalKey })
      .from(Program)
      .where(
        and(
          eq(Program.libraryId, library.uuid),
          eq(Program.sourceType, 'youtube'),
        ),
      );
    let done = 0;
    for (const video of videos) {
      signal.throwIfAborted();
      await this.importVideo(library, video.id, signal);
      progress((++done / videos.length) * 100);
    }
  }
}
