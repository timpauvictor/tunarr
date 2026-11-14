import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import type { ContentProgram } from '@tunarr/types';
import { OtherVideo } from '@tunarr/types/schemas';
import type {
  YouTubeImportResponse,
  YouTubeLinkInput,
  YouTubeLinksImportResponse,
  YouTubeCollection,
  YouTubeCollectionEntry,
  YouTubeCollectionPage,
} from '@tunarr/types/schemas';
import type { MediaSourceId } from '../db/schema/base.ts';
import { ExternalCollectionRepo } from '../db/ExternalCollectionRepo.ts';
import type { YouTubeSnapshotEntry } from '../db/ExternalCollectionRepo.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import { ProgramDaoMinter } from '../db/converters/ProgramMinter.ts';
import { ProgramConverter } from '../db/converters/ProgramConverter.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import type { MediaSourceLibrary } from '../db/schema/MediaSourceLibrary.ts';
import { MediaSourceLibrary as LibraryTable } from '../db/schema/MediaSourceLibrary.ts';
import {
  ExternalCollection,
  ExternalCollectionPrograms,
} from '../db/schema/ExternalCollection.ts';
import type { ProgramUpsertRepository } from '../db/program/ProgramUpsertRepository.ts';
import {
  YouTubeAdapter,
  YouTubeError,
  normalizeYouTubeUrl,
  youtubeCollectionLimit,
} from '../external/youtube/YouTubeAdapter.ts';
import { KEYS } from '../types/inject.ts';
import { MeilisearchService } from './MeilisearchService.ts';

const MaxImportEntries = 10000;

type VideoOutcome = Pick<
  YouTubeCollectionEntry,
  'status' | 'message' | 'program'
>;

function collectionView(collection: ExternalCollection): YouTubeCollection {
  if (!collection.kind) {
    throw new Error('YouTube collection has no persisted kind.');
  }
  return {
    id: collection.uuid,
    sourceId: collection.mediaSourceId,
    title: collection.title,
    kind: collection.kind,
    externalKey: collection.externalKey,
    revision: collection.snapshotId ?? 'legacy',
    lastSuccessfulRefreshAt:
      collection.lastSuccessfulRefreshAt?.getTime() ?? null,
    lastRefreshError: collection.lastRefreshError,
  };
}

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
    @inject(ExternalCollectionRepo) private collections: ExternalCollectionRepo,
  ) {}

  async importVideo(
    library: MediaSourceLibrary,
    videoId: string,
    signal: AbortSignal,
    saveIndividual = true,
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
      tx.update(LibraryTable)
        .set({ lastScannedAt: new Date() })
        .where(eq(LibraryTable.uuid, library.uuid))
        .run();
    });
    const materialized = { ...video, uuid: saved.uuid };
    const contentProgram =
      this.converter.materializedProgramToContentProgram(materialized);
    if (saveIndividual) {
      this.rememberIndividual(
        library,
        metadata.id,
        { status: 'available', program: contentProgram, message: null },
        signal,
      );
    }
    const tasks = await this.search.indexOtherVideo([materialized]);
    const indexSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    for (const task of tasks ?? []) {
      await this.search.waitForTaskResult(task.taskUid, false, indexSignal);
    }
    return {
      sourceId: source.uuid,
      libraryId: library.uuid,
      program: contentProgram,
    };
  }

  async listCollections(sourceId: string): Promise<YouTubeCollection[]> {
    const library = await this.sourceLibrary(sourceId);
    const collections = await this.collections.getByLibraryId(library.uuid);
    return collections.map(collectionView);
  }

  async collectionPage(
    sourceId: string,
    collectionId: string,
    offset: number,
    limit: number,
    order: 'newest' | 'oldest',
    revision?: string,
  ): Promise<YouTubeCollectionPage> {
    const library = await this.sourceLibrary(sourceId);
    const collection = await this.db.query.externalCollections.findFirst({
      where: (c, { and, eq }) =>
        and(
          eq(c.uuid, collectionId),
          eq(c.libraryId, library.uuid),
          eq(c.mediaSourceId, library.mediaSourceId),
        ),
    });
    if (!collection) {
      throw new YouTubeError(
        'INVALID_URL',
        'This collection does not belong to the selected source.',
      );
    }
    const view = collectionView(collection);
    if (revision && view.revision !== revision) {
      throw new YouTubeError(
        'INVALID_METADATA',
        'Collection changed while paging. Reload it before adding.',
      );
    }
    const [rows, total] = await Promise.all([
      this.collections.getOccurrencePage(
        collection.uuid,
        offset,
        limit,
        collection.kind === 'creator_uploads' && order === 'oldest',
      ),
      this.collections.getOccurrenceCount(collection.uuid),
    ]);
    const current = await this.db.query.externalCollections.findFirst({
      where: (c, { eq }) => eq(c.uuid, collectionId),
    });
    if (!current || (current.snapshotId ?? 'legacy') !== view.revision) {
      throw new YouTubeError(
        'INVALID_METADATA',
        'Collection changed while paging. Reload it before adding.',
      );
    }
    return {
      sourceId,
      libraryId: library.uuid,
      collection: view,
      total,
      entries: rows.map((row, index) => {
        const terminal = row.program
          ? this.converter.programDaoToTerminalProgram(row.program)
          : null;
        const program =
          terminal &&
          terminal.sourceType === 'youtube' &&
          terminal.mediaSourceId === sourceId &&
          terminal.duration > 0
            ? this.converter.materializedProgramToContentProgram(terminal)
            : null;
        return {
          id: row.uuid,
          position: row.position ?? offset + index,
          videoId: row.videoId ?? row.program?.externalKey ?? null,
          status:
            row.status === 'available' && !program ? 'pending' : row.status,
          message: row.message,
          program,
        };
      }),
    };
  }

  async importLinks(
    library: MediaSourceLibrary,
    inputs: readonly YouTubeLinkInput[],
    signal: AbortSignal,
    progress: (percent: number) => void,
    refresh = false,
  ): Promise<YouTubeLinksImportResponse> {
    const normalized = inputs.map((input) =>
      normalizeYouTubeUrl(input.url, input.intent),
    );
    const cache = new Map<string, VideoOutcome>();
    const seen = new Set<string>();
    const imports: YouTubeLinksImportResponse['imports'] = [];
    let totalEntries = 0;
    const hydrate = async (
      videoId: string,
      individual: boolean,
    ): Promise<VideoOutcome> => {
      const cached = cache.get(videoId);
      if (cached) {
        return cached;
      }
      signal.throwIfAborted();
      let program: ContentProgram | null = null;
      if (!refresh && !individual) {
        const stored = await this.db.query.program.findFirst({
          where: (p, { and, eq }) =>
            and(
              eq(p.libraryId, library.uuid),
              eq(p.sourceType, 'youtube'),
              eq(p.externalKey, videoId),
            ),
          with: { artwork: true, externalIds: true },
        });
        const terminal =
          stored && stored.duration > 0
            ? this.converter.programDaoToTerminalProgram(stored)
            : null;
        if (terminal) {
          program =
            this.converter.materializedProgramToContentProgram(terminal);
        }
      }
      let outcome: VideoOutcome;
      try {
        program ??= (await this.importVideo(library, videoId, signal, false))
          .program;
        outcome = { status: 'available', program, message: null };
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof YouTubeError &&
          ['PENDING_METADATA', 'UNAVAILABLE', 'UNSUPPORTED_VIDEO'].includes(
            error.code,
          )
        ) {
          outcome = {
            status:
              error.code === 'PENDING_METADATA' ? 'pending' : 'unavailable',
            program: null,
            message: error.message,
          };
        } else {
          throw error;
        }
      }
      cache.set(videoId, outcome);
      return outcome;
    };
    for (const [inputIndex, input] of normalized.entries()) {
      signal.throwIfAborted();
      const key = `${input.kind}:${input.id}`;
      if (seen.has(key)) {
        imports.push({
          inputIndex,
          kind: input.kind,
          title: 'Repeated input',
          status: 'duplicate',
          message:
            'This input was already included. Playlist occurrences are preserved separately.',
          collection: null,
          entries: [],
        });
        continue;
      }
      seen.add(key);
      let externalKey: string | undefined =
        input.kind === 'playlist'
          ? `playlist:${input.id}`
          : input.kind === 'creator' && input.id.startsWith('/channel/')
            ? `creator:${input.id.slice('/channel/'.length)}`
            : undefined;
      try {
        if (input.kind === 'video') {
          totalEntries++;
          if (totalEntries > MaxImportEntries) {
            throw new YouTubeError(
              'SAFETY_LIMIT',
              'Import exceeds the 10000-entry job limit. Import fewer collections together.',
            );
          }
          const outcome = await hydrate(input.id, true);
          signal.throwIfAborted();
          const saved = this.rememberIndividual(
            library,
            input.id,
            outcome,
            signal,
          );
          imports.push({
            inputIndex,
            kind: input.kind,
            status: 'complete',
            title: outcome.program?.program.title ?? 'YouTube video',
            message: outcome.message,
            collection: collectionView(saved.collection),
            entries: [
              {
                id: saved.entry.uuid,
                position: 0,
                videoId: input.id,
                ...outcome,
              },
            ],
          });
        } else {
          const listing = await this.adapter.listing(input, signal);
          externalKey = `${input.kind}:${listing.id}`;
          const canonicalKey = `collection:${externalKey}`;
          if (seen.has(canonicalKey)) {
            imports.push({
              inputIndex,
              kind: input.kind,
              status: 'duplicate',
              title: listing.title,
              message: 'This canonical collection was already included.',
              collection: null,
              entries: [],
            });
            continue;
          }
          seen.add(canonicalKey);
          totalEntries += listing.entries.length;
          if (totalEntries > MaxImportEntries) {
            throw new YouTubeError(
              'SAFETY_LIMIT',
              'Import exceeds the 10000-entry job limit. Import fewer collections together.',
            );
          }
          const snapshot: YouTubeSnapshotEntry[] = [];
          const outcomes: VideoOutcome[] = [];
          for (const [index, entry] of listing.entries.entries()) {
            signal.throwIfAborted();
            const outcome: VideoOutcome =
              !entry.videoId || entry.unavailable
                ? {
                    status: 'unavailable',
                    message:
                      'This listing entry is inaccessible or has no canonical video ID.',
                    program: null,
                  }
                : await hydrate(entry.videoId, false);
            outcomes.push(outcome);
            snapshot.push({
              videoId: entry.videoId,
              upstreamEntryId: null,
              programId: outcome.program?.id ?? null,
              status: outcome.status,
              message: outcome.message,
            });
            progress(
              ((inputIndex +
                (index + 1) / Math.max(1, listing.entries.length)) /
                inputs.length) *
                100,
            );
          }
          signal.throwIfAborted();
          const collection = this.collections.publishYouTubeSnapshot(
            {
              uuid: randomUUID(),
              mediaSourceId: library.mediaSourceId,
              libraryId: library.uuid,
              externalKey,
              sourceType: 'youtube',
              kind: listing.kind,
              title: listing.title,
            },
            snapshot,
            signal,
          );
          const rows = await this.collections.getOccurrencePage(
            collection.uuid,
            0,
            youtubeCollectionLimit(),
            false,
          );
          let entries: YouTubeCollectionEntry[] = rows.map((row, index) => {
            const outcome = outcomes[index];
            if (!outcome) {
              throw new Error(
                'Collection snapshot changed before publication.',
              );
            }
            return {
              id: row.uuid,
              position: row.position ?? index,
              videoId: row.videoId,
              ...outcome,
            };
          });
          if (
            listing.kind === 'creator_uploads' &&
            inputs[inputIndex]?.order === 'oldest'
          ) {
            entries = entries.reverse();
          }
          imports.push({
            inputIndex,
            kind: input.kind,
            status: 'complete',
            title: listing.title,
            collection: collectionView(collection),
            changes: collection.refreshChanges,
            message: null,
            entries,
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        const message =
          error instanceof YouTubeError
            ? error.message
            : 'Import could not finish. The last complete collection snapshot was retained.';
        if (externalKey) {
          await this.collections.recordYouTubeRefreshFailure(
            library.mediaSourceId,
            externalKey,
            message,
          );
        }
        imports.push({
          inputIndex,
          kind: input.kind,
          status: 'failed',
          title: `YouTube ${input.kind}`,
          message,
          collection: null,
          entries: [],
        });
      }
      progress(((inputIndex + 1) / inputs.length) * 100);
    }
    return {
      sourceId: library.mediaSourceId,
      libraryId: library.uuid,
      imports,
    };
  }

  private rememberIndividual(
    library: MediaSourceLibrary,
    videoId: string,
    outcome: VideoOutcome,
    signal: AbortSignal,
  ) {
    return this.db.transaction((tx) => {
      signal.throwIfAborted();
      const currentLibrary = tx
        .select()
        .from(LibraryTable)
        .where(eq(LibraryTable.uuid, library.uuid))
        .get();
      if (
        !currentLibrary ||
        !currentLibrary.enabled ||
        currentLibrary.unavailableSince ||
        currentLibrary.mediaSourceId !== library.mediaSourceId
      ) {
        throw new YouTubeError(
          'UNSUPPORTED_VIDEO',
          'YouTube source or library is no longer available.',
        );
      }
      const collection = tx
        .select()
        .from(ExternalCollection)
        .where(
          and(
            eq(ExternalCollection.mediaSourceId, library.mediaSourceId),
            eq(ExternalCollection.externalKey, 'saved-videos'),
          ),
        )
        .get();
      if (!collection) {
        throw new Error('Saved Videos collection is missing.');
      }
      const existing = tx
        .select()
        .from(ExternalCollectionPrograms)
        .where(
          and(
            eq(ExternalCollectionPrograms.collectionId, collection.uuid),
            or(
              eq(ExternalCollectionPrograms.videoId, videoId),
              outcome.program
                ? eq(ExternalCollectionPrograms.programId, outcome.program.id)
                : undefined,
            ),
          ),
        )
        .get();
      const values = {
        videoId,
        status: outcome.status,
        message: outcome.message,
        programId: outcome.program?.id ?? existing?.programId ?? null,
      };
      const entry = existing
        ? tx
            .update(ExternalCollectionPrograms)
            .set(values)
            .where(eq(ExternalCollectionPrograms.uuid, existing.uuid))
            .returning()
            .get()
        : tx
            .insert(ExternalCollectionPrograms)
            .values({ collectionId: collection.uuid, ...values })
            .returning()
            .get();
      const saved = tx
        .update(ExternalCollection)
        .set({
          snapshotId: randomUUID(),
          lastSuccessfulRefreshAt: new Date(),
          lastRefreshError: null,
        })
        .where(eq(ExternalCollection.uuid, collection.uuid))
        .returning()
        .get();
      if (!entry || !saved) {
        throw new Error('Could not save video occurrence.');
      }
      return { collection: saved, entry };
    });
  }

  private async sourceLibrary(sourceId: string) {
    const source = await this.sources.getById(sourceId as MediaSourceId);
    const library = source?.libraries.find(
      (library) => library.externalKey === 'saved-videos',
    );
    if (
      !source ||
      source.type !== 'youtube' ||
      !library ||
      !library.enabled ||
      library.unavailableSince
    ) {
      throw new YouTubeError(
        'INVALID_URL',
        'YouTube source or library is unavailable.',
      );
    }
    return library;
  }

  async refresh(
    library: MediaSourceLibrary,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const collections = await this.collections.getByLibraryId(library.uuid);
    const rejectOversizedSavedVideos = async (
      collection: ExternalCollection,
    ) => {
      signal.throwIfAborted();
      const message = `Saved Videos exceeds the ${MaxImportEntries}-entry refresh limit. Refresh individual videos or smaller collections instead. The last complete collection and saved programming were retained.`;
      await this.collections.recordYouTubeRefreshFailure(
        library.mediaSourceId,
        collection.externalKey,
        message,
      );
      throw new YouTubeError('SAFETY_LIMIT', message);
    };
    // Reject known oversized work before refreshing any input in this library.
    for (const collection of collections) {
      signal.throwIfAborted();
      if (collection.kind === 'saved_videos') {
        const count = await this.collections.getOccurrenceCount(
          collection.uuid,
        );
        signal.throwIfAborted();
        if (count > MaxImportEntries) {
          await rejectOversizedSavedVideos(collection);
        }
      }
    }
    const inputs: YouTubeLinkInput[] = [];
    for (const collection of collections) {
      signal.throwIfAborted();
      if (collection.kind === 'playlist') {
        inputs.push({
          url: `https://www.youtube.com/playlist?list=${collection.externalKey.slice('playlist:'.length)}`,
          order: 'newest',
        });
      } else if (collection.kind === 'creator_uploads') {
        inputs.push({
          url: `https://www.youtube.com/channel/${collection.externalKey.slice('creator:'.length)}`,
          order: 'newest',
        });
      } else if (collection.kind === 'saved_videos') {
        const rows = await this.collections.getOccurrencePage(
          collection.uuid,
          0,
          MaxImportEntries + 1,
          false,
        );
        signal.throwIfAborted();
        if (rows.length > MaxImportEntries) {
          await rejectOversizedSavedVideos(collection);
        }
        for (const row of rows) {
          const id = row.videoId ?? row.program?.externalKey;
          if (id) {
            inputs.push({
              url: `https://www.youtube.com/watch?v=${id}`,
              order: 'newest',
            });
          }
        }
      }
    }
    if (!inputs.length) {
      progress(100);
      return;
    }
    const result = await this.importLinks(
      library,
      inputs,
      signal,
      progress,
      true,
    );
    if (result.imports.some((input) => input.status === 'failed')) {
      throw new Error(
        'Some metadata refreshes failed. Their last complete collection snapshots and all saved programming were retained.',
      );
    }
  }
}
