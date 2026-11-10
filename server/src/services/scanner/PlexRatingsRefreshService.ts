import type {
  PlexRatingsRefreshStatus,
  RatingSnapshot,
} from '@tunarr/types/schemas';
import {
  PlexMetadataIdentitySchema,
  PlexRawMetadataContainerResponseSchema,
} from '@tunarr/types/plex';
import { ratingFieldKey } from '@tunarr/shared/util';
import { isAxiosError } from 'axios';
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { v4 } from 'uuid';
import z from 'zod';
import type { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import { registerRatingFields } from '../../db/program/ratingFields.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.ts';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';
import { MediaSource } from '../../db/schema/MediaSource.ts';
import { MediaSourceLibrary } from '../../db/schema/MediaSourceLibrary.ts';
import { Program } from '../../db/schema/Program.ts';
import { ProgramGrouping } from '../../db/schema/ProgramGrouping.ts';
import { extractPlexRatings } from '../../external/plex/plexRatings.ts';
import { KEYS } from '../../types/inject.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { MeilisearchService } from '../MeilisearchService.ts';

type Library = NonNullable<Awaited<ReturnType<MediaSourceDB['getLibrary']>>>;
type RefreshError = NonNullable<PlexRatingsRefreshStatus['lastError']>;
type RatingsClientFactory = {
  getPlexApiClientForMediaSource(
    source: MediaSourceWithRelations,
  ): Promise<Pick<PlexApiClient, 'doGet'>>;
};
type Target = {
  entity: 'program' | 'grouping';
  uuid: string;
  externalKey: string | null;
  type: string;
};
const IdentitySchema = PlexMetadataIdentitySchema.extend({
  subtype: z.string().optional(),
  librarySectionID: z.union([z.number(), z.string()]).optional(),
});

function entrySignature(snapshot: RatingSnapshot | null): string {
  return JSON.stringify(
    snapshot?.entries
      .map((entry) => [
        ratingFieldKey(entry.providerId, entry.kind),
        entry.value,
        entry.scale,
        entry.score,
        entry.source ?? null,
        entry.isAlias ?? false,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ?? null,
  );
}

@injectable()
export class PlexRatingsRefreshService {
  private jobs = new Map<string, PlexRatingsRefreshStatus>();
  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(KEYS.DrizzleDB) private db: DrizzleDBAccess,
    @inject(KEYS.MediaSourceApiFactory)
    private apiFactory: () => RatingsClientFactory,
    @inject(MeilisearchService)
    private search: Pick<MeilisearchService, 'updateRatings'>,
  ) {}

  getStatus(libraryId: string): PlexRatingsRefreshStatus | null {
    const state = this.jobs.get(libraryId);
    return state ? { ...state } : null;
  }

  queue(libraryId: string, mediaSourceId: string): PlexRatingsRefreshStatus {
    const existing = this.jobs.get(libraryId);
    if (existing?.state === 'queued' || existing?.state === 'in_progress')
      throw new Error('Ratings refresh already active');
    const state: PlexRatingsRefreshStatus = {
      jobId: v4(),
      libraryId,
      mediaSourceId,
      state: 'queued',
      cancelRequested: false,
      total: 0,
      processed: 0,
      refreshed: 0,
      unchanged: 0,
      failed: 0,
      skipped: 0,
      indexFailed: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    };
    this.jobs.set(libraryId, state);
    return { ...state };
  }

  cancelQueued(libraryId: string, jobId: string): void {
    const state = this.jobs.get(libraryId);
    if (state?.jobId === jobId && state.state === 'queued') {
      state.state = 'cancelled';
      state.cancelRequested = true;
      state.finishedAt = Date.now();
    }
  }

  fail(libraryId: string, jobId: string): void {
    const state = this.jobs.get(libraryId);
    if (
      state?.jobId === jobId &&
      (state.state === 'queued' || state.state === 'in_progress')
    ) {
      state.state = 'failed';
      state.lastError = 'database';
      state.finishedAt = Date.now();
    }
  }

  requestCancel(libraryId: string, jobId: string): boolean {
    const state = this.jobs.get(libraryId);
    if (
      !state ||
      state.jobId !== jobId ||
      (state.state !== 'queued' && state.state !== 'in_progress')
    )
      return false;
    state.cancelRequested = true;
    return true;
  }

  async run(
    jobId: string,
    library: Library,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<void> {
    const state = this.jobs.get(library.uuid);
    if (!state || state.jobId !== jobId)
      throw new Error('Unknown ratings refresh job');
    const work = new AbortController();
    const cancel = () => {
      state.cancelRequested = true;
      work.abort();
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    let fatal: RefreshError | undefined;
    state.startedAt = Date.now();
    state.state = 'in_progress';
    try {
      if (work.signal.aborted) return;
      // Capture lightweight identities in one short read transaction. No media
      // or snapshots are materialized here; live edits cannot expand the job
      // into discovery or move its write authority to another entity.
      const targets: Target[] = this.db.transaction((tx) => [
        ...tx
          .select({
            uuid: Program.uuid,
            externalKey: Program.externalKey,
            type: Program.type,
          })
          .from(Program)
          .where(
            and(
              eq(Program.libraryId, library.uuid),
              eq(Program.mediaSourceId, library.mediaSourceId),
              eq(Program.sourceType, 'plex'),
            ),
          )
          .all()
          .map((row) => ({ ...row, entity: 'program' as const })),
        ...tx
          .select({
            uuid: ProgramGrouping.uuid,
            externalKey: ProgramGrouping.externalKey,
            type: ProgramGrouping.type,
          })
          .from(ProgramGrouping)
          .where(
            and(
              eq(ProgramGrouping.libraryId, library.uuid),
              eq(ProgramGrouping.mediaSourceId, library.mediaSourceId),
              eq(ProgramGrouping.sourceType, 'plex'),
            ),
          )
          .all()
          .map((row) => ({ ...row, entity: 'grouping' as const })),
      ]);
      state.total = targets.length;
      // The API client normalizes URI in place. Clone the options so authority
      // comparisons keep the exact admitted account/endpoint snapshot.
      const client = await this.apiFactory().getPlexApiClientForMediaSource({
        ...library.mediaSource,
      });
      for (
        let offset = 0;
        offset < targets.length && !work.signal.aborted;
        offset += 50
      ) {
        const page = targets.slice(offset, offset + 50);
        const updates: { id: string; ratings: RatingSnapshot }[] = [];
        let next = 0;
        const worker = async () => {
          while (next < page.length && !work.signal.aborted) {
            const target = page[next++];
            if (!target) return;
            if (!target.externalKey) {
              state.skipped++;
              state.processed++;
              state.lastError = 'identity_changed';
              continue;
            }
            const request = new AbortController();
            const abort = () => request.abort();
            let timedOut = false;
            work.signal.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => {
              timedOut = true;
              request.abort();
            }, 10_000);
            let raw: unknown;
            try {
              raw = await client.doGet({
                url: `/library/metadata/${encodeURIComponent(target.externalKey)}`,
                timeout: 10_000,
                signal: request.signal,
                maxContentLength: 4 * 1024 * 1024,
              });
            } catch (error) {
              if (signal.aborted || (work.signal.aborted && !timedOut))
                state.skipped++;
              else {
                const status = isAxiosError(error)
                  ? error.response?.status
                  : undefined;
                const code: RefreshError =
                  status === 401
                    ? 'auth'
                    : status === 403
                      ? 'denied'
                      : status === 404
                        ? 'not_found'
                        : timedOut
                          ? 'timeout'
                          : 'invalid_metadata';
                state.lastError = code;
                state.failed++;
                this.logger.warn(
                  'Plex ratings refresh failed for entity %s (%s)',
                  target.uuid,
                  code,
                );
                if (code === 'auth') {
                  fatal = code;
                  work.abort();
                }
              }
              state.processed++;
              progress(
                state.total === 0 ? 100 : (100 * state.processed) / state.total,
              );
              continue;
            } finally {
              clearTimeout(timer);
              work.signal.removeEventListener('abort', abort);
            }
            if (work.signal.aborted) {
              state.skipped++;
              state.processed++;
              continue;
            }
            const container =
              PlexRawMetadataContainerResponseSchema.safeParse(raw);
            const metadata =
              container.success &&
              container.data.MediaContainer.Metadata?.length === 1
                ? container.data.MediaContainer.Metadata[0]
                : undefined;
            const identity = IdentitySchema.safeParse(metadata);
            const expectedType =
              target.type === 'other_video' || target.type === 'music_video'
                ? 'movie'
                : target.type;
            const validIdentity =
              identity.success &&
              identity.data.ratingKey === target.externalKey &&
              identity.data.type === expectedType &&
              (target.type !== 'other_video' ||
                identity.data.subtype === 'clip') &&
              (target.type !== 'music_video' ||
                identity.data.subtype === 'clip' ||
                identity.data.subtype === 'musicvideo') &&
              (identity.data.librarySectionID === undefined ||
                String(identity.data.librarySectionID) === library.externalKey);
            const extracted = validIdentity
              ? extractPlexRatings(metadata)
              : { snapshot: undefined, error: 'Invalid metadata identity' };
            if (!extracted.snapshot) {
              state.failed++;
              state.lastError = 'invalid_metadata';
              this.logger.warn(
                'Plex ratings metadata rejected for entity %s',
                target.uuid,
              );
            } else {
              try {
                const snapshot = extracted.snapshot;
                const result = this.db.transaction((tx) => {
                  const source = tx
                    .select()
                    .from(MediaSource)
                    .where(eq(MediaSource.uuid, library.mediaSourceId))
                    .get();
                  const currentLibrary = tx
                    .select()
                    .from(MediaSourceLibrary)
                    .where(eq(MediaSourceLibrary.uuid, library.uuid))
                    .get();
                  if (
                    !source ||
                    source.type !== 'plex' ||
                    source.uri !== library.mediaSource.uri ||
                    source.accessToken !== library.mediaSource.accessToken ||
                    !currentLibrary?.enabled ||
                    currentLibrary.mediaSourceId !== library.mediaSourceId ||
                    currentLibrary.unavailableSince !== null
                  )
                    return 'source_changed' as const;
                  const table =
                    target.entity === 'program' ? Program : ProgramGrouping;
                  const current = tx
                    .select()
                    .from(table)
                    .where(eq(table.uuid, target.uuid))
                    .get();
                  if (
                    !current ||
                    current.mediaSourceId !== library.mediaSourceId ||
                    current.libraryId !== library.uuid ||
                    current.externalKey !== target.externalKey ||
                    current.type !== target.type ||
                    current.sourceType !== 'plex'
                  )
                    return 'identity_changed' as const;
                  registerRatingFields(tx, [snapshot]);
                  tx.update(table)
                    .set({ ratings: snapshot })
                    .where(eq(table.uuid, target.uuid))
                    .run();
                  return entrySignature(current.ratings) ===
                    entrySignature(snapshot)
                    ? ('unchanged' as const)
                    : ('refreshed' as const);
                });
                if (result === 'source_changed') {
                  fatal = result;
                  state.lastError = result;
                  state.skipped++;
                  work.abort();
                } else if (result === 'identity_changed') {
                  state.lastError = result;
                  state.skipped++;
                } else {
                  state[result]++;
                  updates.push({ id: target.uuid, ratings: snapshot });
                }
              } catch {
                state.failed++;
                state.lastError = 'database';
                fatal = 'database';
                work.abort();
                this.logger.warn(
                  'Could not persist Plex ratings for entity %s',
                  target.uuid,
                );
              }
            }
            state.processed++;
            progress(
              state.total === 0 ? 100 : (100 * state.processed) / state.total,
            );
          }
        };
        await Promise.all([worker(), worker()]);
        if (updates.length > 0) {
          try {
            const result = await this.search.updateRatings(updates, signal);
            if (result.unindexed > 0) {
              state.indexFailed += result.unindexed;
              state.lastError = 'index';
              fatal = 'index';
              work.abort();
            }
          } catch {
            state.indexFailed += updates.length;
            state.lastError = 'index';
            fatal = 'index';
            work.abort();
          }
        }
      }
    } catch {
      fatal = 'database';
      state.lastError = fatal;
    } finally {
      signal.removeEventListener('abort', cancel);
      work.abort();
      state.finishedAt = Date.now();
      state.state = signal.aborted
        ? 'cancelled'
        : fatal && state.refreshed + state.unchanged === 0
          ? 'failed'
          : fatal ||
              state.failed > 0 ||
              state.skipped > 0 ||
              state.indexFailed > 0 ||
              state.processed < state.total
            ? 'partial'
            : 'completed';
    }
  }
}
