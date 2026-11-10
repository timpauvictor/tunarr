import type { MediaSourceId } from '@tunarr/shared';
import type {
  PlexRatingsRefreshStatus,
  YouTubeImportResponse,
  YouTubeLinkInput,
  YouTubeLinksImportResponse,
} from '@tunarr/types/schemas';
import { YouTubeImportService } from '../YouTubeImportService.ts';
import type { MediaSourceLibrary } from '../../db/schema/MediaSourceLibrary.ts';
import { PlexRatingsRefreshService } from './PlexRatingsRefreshService.ts';
import { E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';
import { inject, injectable } from 'inversify';
import PQueue from 'p-queue';
import { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import type { MediaSourceType } from '../../db/schema/base.ts';
import { ReconcileProgramDurationsTask } from '../../tasks/ReconcileProgramDurationsTask.ts';
import { autoFactoryKey, KEYS } from '../../types/inject.ts';
import { Result } from '../../types/result.ts';
import type { Maybe } from '../../types/util.ts';
import { InjectLogger } from '../../util/inject.ts';
import { caughtErrorToError } from '../../util/index.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { EntityMutex } from '../EntityMutex.ts';
import { GlobalScheduler } from '../Scheduler.ts';
import type { GenericExternalCollectionScanner } from './ExternalCollectionScanner.ts';
import type { GenericLocalMediaSourceScannerFactory } from './FileSystemScanner.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import type { GenericMediaSourceScannerFactory } from './MediaSourceScanner.ts';

@injectable()
export class MediaSourceScanCoordinator {
  private static queue: PQueue = new PQueue({ concurrency: 1 });
  private static signalById: Map<string, AbortController> = new Map();

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(MediaSourceDB)
    private mediaSourceDB: Pick<MediaSourceDB, 'getById' | 'getLibrary'>,
    @inject(EntityMutex) private entityMutex: EntityMutex,
    @inject(KEYS.MediaSourceLibraryScanner)
    private scannerFactory: GenericMediaSourceScannerFactory,
    @inject(KEYS.LocalMediaSourceScanner)
    private localScannerFactory: GenericLocalMediaSourceScannerFactory,
    @inject(MediaSourceProgressService)
    private progressService: MediaSourceProgressService,
    @inject(KEYS.ExternalCollectionScannerFactory)
    private collectionScannerFactory: (
      sourceType: MediaSourceType,
    ) => Maybe<GenericExternalCollectionScanner>,
    @inject(autoFactoryKey(ReconcileProgramDurationsTask))
    private reconcileDurationsTaskFactory: () => ReconcileProgramDurationsTask,
    @inject(PlexRatingsRefreshService)
    private ratingsRefresh: PlexRatingsRefreshService,
    @inject(YouTubeImportService)
    private youtubeImports: Pick<
      YouTubeImportService,
      'importVideo' | 'importLinks' | 'refresh'
    >,
  ) {}

  async addLocal({
    mediaSourceId,
    forceScan,
    pathFilter,
  }: LocalScanRequest): Promise<boolean> {
    const mediaSource = await this.mediaSourceDB.getById(mediaSourceId);
    if (!mediaSource) {
      this.logger.error('No media source find with ID %s', mediaSourceId);
      return false;
    }

    const mediaSourceType = mediaSource.type;
    if (mediaSourceType !== 'local') {
      this.logger.error(
        'Scanning remote libraries is not supported by this scanner',
      );
      return false;
    }

    try {
      const lock = tryAcquire(
        await this.entityMutex.getLockForMediaSource(mediaSource),
      );
      const releaser = await lock.acquire();
      const scanner = Result.attempt(() =>
        this.localScannerFactory(mediaSource.mediaType!),
      ).orNull();

      if (!scanner) {
        this.logger.error(
          'Could not create scanner for media source: %O',
          mediaSource,
        );
        return false;
      }

      this.progressService.scanQueued(mediaSource.uuid);
      const controller = new AbortController();
      MediaSourceScanCoordinator.signalById.set(mediaSource.uuid, controller);
      MediaSourceScanCoordinator.queue
        .add(async () => {
          try {
            controller.signal.addEventListener('abort', () => {
              scanner.cancel();
            });
            await scanner.scan({ mediaSource, force: forceScan, pathFilter });
          } finally {
            releaser();
          }
        })
        .catch((e) =>
          this.logger.error(
            e,
            'Error scanning media source %s',
            mediaSource.uuid,
          ),
        )
        .finally(() => {
          if (
            MediaSourceScanCoordinator.signalById.get(mediaSource.uuid) ===
            controller
          )
            MediaSourceScanCoordinator.signalById.delete(mediaSource.uuid);
          this.reconcileProgramDurations();
        });

      return true;
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        this.logger.error(
          'Could not acquire lock for mediaSource: %s',
          mediaSource.uuid,
        );
      } else {
        this.logger.error(
          e,
          'Error while scheduling scan for mediaSource: %s',
          mediaSource.uuid,
        );
      }
      return false;
    }
  }

  async add({
    libraryId,
    forceScan,
    pathFilter,
  }: ScanRequest): Promise<boolean> {
    const library = await this.mediaSourceDB.getLibrary(libraryId);

    if (!library) {
      this.logger.error('No library found with ID %s', libraryId);
      return false;
    }

    // Scanning a library the server no longer reports would mark all of its
    // programs missing.
    if (library.unavailableSince !== null) {
      this.logger.warn(
        "Skipping scan of library '%s' (ID = %s): unavailable since %s",
        library.name,
        library.uuid,
        library.unavailableSince.toISOString(),
      );
      return false;
    }

    const mediaSourceType = library.mediaSource.type;
    if (mediaSourceType === 'youtube') {
      try {
        const operation = await this.queueYouTubeOperation(
          library,
          new AbortController().signal,
          (signal) =>
            this.youtubeImports.refresh(library, signal, (percent) =>
              this.progressService.scanProgress(library.uuid, percent),
            ),
        );
        void operation.finished.catch(() =>
          this.logger.warn(
            'YouTube metadata refresh failed for library %s; saved programs and schedules were retained.',
            library.uuid,
          ),
        );
        return true;
      } catch {
        return false;
      }
    }
    if (mediaSourceType === 'local') {
      this.logger.error('Scanning local libraries is not supported by scanner');
      return false;
    }

    try {
      const lock = tryAcquire(
        await this.entityMutex.getLockForLibrary(library),
      );
      const releaser = await lock.acquire();
      const scanner = Result.attempt(() =>
        this.scannerFactory(mediaSourceType, library.mediaType),
      ).orNull();

      if (!scanner) {
        this.logger.error('Could not create scanner for library: %O', library);
        return false;
      }

      const collectionScanner = this.collectionScannerFactory(
        library.mediaSource.type,
      );

      this.progressService.scanQueued(library.uuid);
      const controller = new AbortController();
      MediaSourceScanCoordinator.signalById.set(library.uuid, controller);
      MediaSourceScanCoordinator.queue
        .add(async () => {
          try {
            controller.signal.addEventListener('abort', () => {
              scanner.cancel(library.uuid);
            });
            await scanner.scan({ library, force: forceScan, pathFilter });
            if (collectionScanner) {
              await collectionScanner.scanLibrary({
                libraryId: library.uuid,
                force: forceScan,
              });
            }
          } finally {
            releaser();
          }
        })
        .catch((e) =>
          this.logger.error(e, 'Error scanning library %s', library.uuid),
        )
        .finally(() => {
          if (
            MediaSourceScanCoordinator.signalById.get(library.uuid) ===
            controller
          )
            MediaSourceScanCoordinator.signalById.delete(library.uuid);
          this.reconcileProgramDurations();
        });

      return true;
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        this.logger.error(
          'Could not acquire lock for library: %s',
          library.uuid,
        );
      } else {
        this.logger.error(
          e,
          'Error while scheduling scan for library: %s',
          library.uuid,
        );
      }
      return false;
    }
  }

  async importYouTubeVideo(
    sourceId: string,
    videoId: string,
    signal: AbortSignal,
  ): Promise<YouTubeImportResponse> {
    const source = await this.mediaSourceDB.getById(sourceId as MediaSourceId);
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
      throw new Error('YouTube source or Saved Videos library is unavailable.');
    }
    const operation = await this.queueYouTubeOperation(
      library,
      signal,
      (owner) => this.youtubeImports.importVideo(library, videoId, owner),
    );
    return operation.finished;
  }

  async importYouTubeLinks(
    sourceId: string,
    inputs: readonly YouTubeLinkInput[],
    signal: AbortSignal,
    refresh = false,
  ): Promise<YouTubeLinksImportResponse> {
    const source = await this.mediaSourceDB.getById(sourceId as MediaSourceId);
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
      throw new Error('YouTube source or Saved Videos library is unavailable.');
    }
    const operation = await this.queueYouTubeOperation(
      library,
      signal,
      (owner) =>
        this.youtubeImports.importLinks(
          library,
          inputs,
          owner,
          (percent) => this.progressService.scanProgress(library.uuid, percent),
          refresh,
        ),
    );
    return operation.finished;
  }

  private async queueYouTubeOperation<T>(
    library: MediaSourceLibrary,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ finished: Promise<T> }> {
    signal.throwIfAborted();
    const release = await tryAcquire(
      await this.entityMutex.getLockForLibrary(library),
    ).acquire();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    let started = false;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener('abort', abort);
      if (
        MediaSourceScanCoordinator.signalById.get(library.uuid) === controller
      ) {
        MediaSourceScanCoordinator.signalById.delete(library.uuid);
      }
      this.progressService.scanEnded(library.uuid);
      release();
    };
    MediaSourceScanCoordinator.signalById.set(library.uuid, controller);
    this.progressService.scanQueued(library.uuid);
    return {
      finished: new Promise<T>((resolve, reject) => {
        const cancelQueued = () => {
          if (!started) {
            finish();
            reject(new Error('YouTube import cancelled.'));
          }
        };
        controller.signal.addEventListener('abort', cancelQueued, {
          once: true,
        });
        if (controller.signal.aborted) {
          cancelQueued();
        }
        void MediaSourceScanCoordinator.queue
          .add(async () => {
            started = true;
            if (finished) {
              return;
            }
            try {
              controller.signal.throwIfAborted();
              const current = await this.mediaSourceDB.getLibrary(library.uuid);
              if (
                !current ||
                current.mediaSourceId !== library.mediaSourceId ||
                current.mediaSource.type !== 'youtube' ||
                !current.enabled ||
                current.unavailableSince
              ) {
                throw new Error('YouTube library is unavailable.');
              }
              controller.signal.throwIfAborted();
              this.progressService.scanStarted(library.uuid);
              resolve(await action(controller.signal));
            } catch (error) {
              reject(caughtErrorToError(error));
            } finally {
              controller.signal.removeEventListener('abort', cancelQueued);
              finish();
            }
          })
          .catch((error) => {
            controller.signal.removeEventListener('abort', cancelQueued);
            finish();
            reject(caughtErrorToError(error));
          });
      }),
    };
  }

  async addRatingsRefresh(
    mediaSourceId: string,
    libraryId: string,
  ): Promise<PlexRatingsRefreshStatus | null> {
    const library = await this.mediaSourceDB.getLibrary(libraryId);
    if (
      !library ||
      library.mediaSourceId !== mediaSourceId ||
      library.mediaSource.type !== 'plex' ||
      !library.enabled ||
      library.unavailableSince !== null
    )
      return null;
    try {
      const release = await tryAcquire(
        await this.entityMutex.getLockForLibrary(library),
      ).acquire();
      // A queued whole-source scan owns the parent even before it enters this
      // library. Do not reserve a child lock behind that source's queue slot.
      if (this.entityMutex.isMediaSourceLocked(library.mediaSource)) {
        release();
        return null;
      }
      let scheduled = false;
      let started = false;
      let finished = false;
      let job: PlexRatingsRefreshStatus | undefined;
      const controller = new AbortController();
      const finish = () => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener('abort', abortQueued);
        try {
          if (job) this.progressService.scanEnded(library.uuid);
        } finally {
          if (
            MediaSourceScanCoordinator.signalById.get(library.uuid) ===
            controller
          )
            MediaSourceScanCoordinator.signalById.delete(library.uuid);
          release();
        }
      };
      const abortQueued = () => {
        if (!started && job) {
          this.ratingsRefresh.cancelQueued(library.uuid, job.jobId);
          finish();
        }
      };
      try {
        job = this.ratingsRefresh.queue(library.uuid, library.mediaSourceId);
        const jobId = job.jobId;
        MediaSourceScanCoordinator.signalById.set(library.uuid, controller);
        controller.signal.addEventListener('abort', abortQueued, {
          once: true,
        });
        this.progressService.scanQueued(library.uuid, 'ratings');
        const pending = MediaSourceScanCoordinator.queue.add(async () => {
          started = true;
          if (finished) return;
          try {
            this.progressService.scanStarted(library.uuid, 'ratings');
            await this.ratingsRefresh.run(
              jobId,
              library,
              controller.signal,
              (percent) =>
                this.progressService.scanProgress(library.uuid, percent),
            );
          } catch {
            this.ratingsRefresh.fail(library.uuid, jobId);
            this.logger.warn(
              'Plex ratings refresh failed for library %s',
              library.uuid,
            );
          } finally {
            finish();
          }
        });
        // Keep the queue slot until active cleanup settles. PQueue's own abort
        // race would release it while the cancelled callback is still running.
        scheduled = true;
        void pending.catch(() => {
          if (!started) {
            if (controller.signal.aborted)
              this.ratingsRefresh.cancelQueued(library.uuid, jobId);
            else this.ratingsRefresh.fail(library.uuid, jobId);
            finish();
          } else if (!controller.signal.aborted) {
            this.logger.warn(
              'Plex ratings refresh could not finish for library %s',
              library.uuid,
            );
          }
        });
        return job;
      } finally {
        if (!scheduled) {
          if (job) this.ratingsRefresh.fail(library.uuid, job.jobId);
          finish();
        }
      }
    } catch (error) {
      if (error !== E_ALREADY_LOCKED)
        this.logger.warn(
          'Could not queue ratings refresh for library %s',
          library.uuid,
        );
      return null;
    }
  }

  cancelRatingsRefresh(libraryId: string, jobId: string): boolean {
    if (!this.ratingsRefresh.requestCancel(libraryId, jobId)) return false;
    const controller = MediaSourceScanCoordinator.signalById.get(libraryId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // A scan can change program durations. Channel lineups keep their own copy,
  // which streaming schedules from, so it is brought back in line here.
  private reconcileProgramDurations() {
    GlobalScheduler.runTask(this.reconcileDurationsTaskFactory(), undefined);
  }

  cancelAll() {
    for (const controller of MediaSourceScanCoordinator.signalById.values()) {
      controller.abort();
    }
  }

  awaitAllFinished() {
    return MediaSourceScanCoordinator.queue.onIdle();
  }
}

type ScanRequest = {
  libraryId: string;
  forceScan: boolean;
  pathFilter?: string;
};

type LocalScanRequest = {
  mediaSourceId: MediaSourceId;
  forceScan: boolean;
  pathFilter?: string;
};
