import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { TranscodeSessionResult } from '@/ffmpeg/types.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type { Watermark } from '@tunarr/types';
import dayjs from 'dayjs';
import { isUndefined } from 'lodash-es';
import events from 'node:events';
import { PassThrough } from 'node:stream';
import { match, P } from 'ts-pattern';
import type {
  ContentBackedStreamLineupItem,
  ErrorStreamLineupItem,
  OfflineStreamLineupItem,
} from '../db/derived_types/StreamLineup.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { FFmpegAssistedFactory } from '../ffmpeg/FFmpegModule.ts';
import type { StreamOptions } from '../ffmpeg/types.ts';
import { KEYS } from '../types/inject.ts';
import { assisted, injected, multiInjected } from '../util/assistedInject.ts';
import { caughtErrorToError, isDefined } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { PlayerContext } from './PlayerStreamContext.ts';
import { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';
import type { ProgramStreamPlugin } from './plugins/ProgramStreamPlugin.ts';
import type { StreamRenditions } from './types.ts';
import { WatermarkResolver } from './WatermarkResolver.ts';
import {
  StreamProgramCalculator,
  playbackPreparationTiming,
} from './StreamProgramCalculator.ts';

type ProgramStreamEvents = {
  // Emitted when the stream has reached a fatal error point
  // This means that both the program and error stream have failed to play.
  error: [];
};

/**
 * Implements the functionality of managing an output stream
 * for a given program. This class is essentially a lineup item + transcode session
 */
export class ProgramStream extends events.EventEmitter<ProgramStreamEvents> {
  @InjectLogger() declare private readonly logger: Logger;

  private outStream?: PassThrough;
  private hadError: boolean = false;
  private _transcodeSession: Maybe<FfmpegTranscodeSession>;
  private _renditions?: StreamRenditions;
  private readonly lifetime = new AbortController();
  private mediaAttempt?: AbortController;
  private replacement?: Promise<void>;
  private recalculatedStartup = false;
  private shortfallMs = 0;
  private readonly contextAbort = () => this.shutdown();

  constructor(
    @injected(KEYS.SettingsDB) protected settingsDB: ISettingsDB,
    @injected(WatermarkResolver) private watermarkResolver: WatermarkResolver,
    @injected(KEYS.FFmpegFactory)
    protected ffmpegFactory: FFmpegAssistedFactory,
    @injected(MediaSourceDB) private mediaSourceDB: MediaSourceDB,
    @injected(ProgramStreamDetailsFetcher)
    private programStreamDetails: ProgramStreamDetailsFetcher,
    @multiInjected(KEYS.ProgramStreamPlugin)
    private streamPlugins: ProgramStreamPlugin[],
    @injected(StreamProgramCalculator)
    private calculator: StreamProgramCalculator,
    @assisted public context: PlayerContext,
    @assisted protected outputFormat: OutputFormat,
    @assisted public opts?: Partial<StreamOptions>,
  ) {
    super();
  }

  async setup(): Promise<Result<FfmpegTranscodeSession>> {
    this.context.playbackSignal?.addEventListener('abort', this.contextAbort, {
      once: true,
    });
    if (this.isInitialized()) {
      return Result.success(this._transcodeSession!);
    }

    // A throw here would skip the caller's error-stream fallback, and the
    // session would retry the same item in a tight loop.
    const result = await this.setupInternal().catch((e: unknown) =>
      Result.forError<TranscodeSessionResult>(caughtErrorToError(e)),
    );

    if (result.isFailure()) {
      this.mediaAttempt?.abort();
      this.context.playbackSignal?.removeEventListener(
        'abort',
        this.contextAbort,
      );
    }
    result.forEach((value) => {
      this.transcodeSession = value.session;
      this._renditions = value.renditions;
    });

    return result.map((r) => r.session);
  }

  protected async setupInternal(): Promise<Result<TranscodeSessionResult>> {
    const { lineupItem } = this.context;
    return match(lineupItem)
      .with({ type: P.union('program', 'commercial', 'fallback') }, (item) =>
        this.setupContentItem(item),
      )
      .with({ type: 'offline' }, (item) => this.setupOfflineItem(item))
      .with({ type: 'error' }, (item) => this.setupErrorItem(item))
      .with({ type: 'redirect' }, (item) =>
        Result.failure<TranscodeSessionResult>(
          `ProgramStream cannot direct play a direct item: ${JSON.stringify(item)}`,
        ),
      )
      .exhaustive();
  }

  private async setupContentItem(
    lineupItem: ContentBackedStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const server = await this.mediaSourceDB.getById(
      lineupItem.program.mediaSourceId,
    );
    if (!server) {
      return Result.forError(
        new Error(
          `Unable to find server "${lineupItem.program.mediaSourceId}" specified by program.`,
        ),
      );
    }

    const youtube = server.type === 'youtube';
    // Live consumers provide a schedule clock. A named diagnostic run does not
    // follow that schedule and must not change programs while it prepares.
    const followsSchedule =
      youtube && this.context.playbackStartTimeMs !== undefined;
    const plannedStartMs = this.context.playbackStartTimeMs ?? Date.now();
    const scheduleTimeMs = this.context.scheduleTimeMs ?? plannedStartMs;
    this.mediaAttempt?.abort();
    this.mediaAttempt = new AbortController();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.mediaAttempt.signal,
      ...(this.context.playbackSignal ? [this.context.playbackSignal] : []),
    ]);
    signal.throwIfAborted();
    const streamDetailsResult = await this.programStreamDetails.getStream({
      server,
      lineupItem: lineupItem.program,
      ...(youtube
        ? {
            signal,
            maxHeight: this.context.transcodeConfig.resolution.heightPx,
            ...(followsSchedule
              ? { expiresAt: plannedStartMs + lineupItem.streamDuration }
              : {}),
          }
        : {}),
    });
    this.lifetime.signal.throwIfAborted();
    this.context.playbackSignal?.throwIfAborted();
    if (followsSchedule) {
      const timing = playbackPreparationTiming(
        plannedStartMs,
        lineupItem.streamDuration,
        Date.now(),
      );
      this.context.playbackStartTimeMs = timing.startMs;
      this.context.scheduleTimeMs = scheduleTimeMs + timing.elapsedMs;
      if (timing.remainingMs <= 0) {
        this.mediaAttempt.abort();
        if (this.recalculatedStartup) {
          return Result.failure(
            'Playback preparation crossed another schedule boundary.',
          );
        }
        this.recalculatedStartup = true;
        const next = await this.calculator.getCurrentLineupItem({
          channelId: this.context.sourceChannel.uuid,
          startTime: this.context.scheduleTimeMs,
          allowSkip: true,
          recordPlayHistory: false,
        });
        if (next.isFailure()) {
          return next.recast();
        }
        this.context.lineupItem = next.get().lineupItem;
        this.context.targetChannel = next.get().channelContext;
        return this.setupInternal();
      }
      let offset = (lineupItem.startOffset ?? 0) + timing.elapsedMs;
      if (
        lineupItem.type === 'commercial' &&
        lineupItem.infiniteLoop &&
        lineupItem.program.duration > 0
      ) {
        offset %= lineupItem.program.duration;
      }
      lineupItem = {
        ...lineupItem,
        streamDuration: timing.remainingMs,
        startOffset: offset,
      };
      this.context.lineupItem = lineupItem;
    }
    if (streamDetailsResult.isFailure()) {
      return streamDetailsResult.recast();
    }
    signal.throwIfAborted();

    const watermark = await this.getWatermark();
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.sourceChannel,
    );

    signal.throwIfAborted();
    const { streamDetails, inputs } = streamDetailsResult.get();
    this.shortfallMs =
      youtube && !lineupItem.infiniteLoop
        ? Math.max(
            0,
            lineupItem.streamDuration -
              Math.max(
                0,
                streamDetails.duration.asMilliseconds() -
                  (lineupItem.startOffset ?? 0),
              ),
          )
        : 0;
    streamDetails.duration = dayjs.duration(lineupItem.streamDuration);

    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    const resolvedOptions = {
      startTime: start,
      duration: dayjs.duration(lineupItem.streamDuration),
      watermark,
      realtime: this.context.realtime,
      outputFormat: this.outputFormat,
      streamMode: this.context.streamMode,
      encoding: this.context.encoding,
      ...(this.opts ?? {}),
    };
    const sessionResult = await ffmpeg.createStreamSession({
      stream: { inputs, details: streamDetails },
      options: resolvedOptions,
      lineupItem,
    });

    if (signal.aborted) {
      sessionResult?.session.kill();
      signal.throwIfAborted();
    }
    if (!sessionResult) {
      return Result.forError(new Error('Unable to create ffmpeg process'));
    }

    for (const plugin of this.streamPlugins) {
      try {
        await plugin.run({
          opts: resolvedOptions,
          outputFormat: this.outputFormat,
          playerContext: this.context,
          transcodeSession: sessionResult,
        });
      } catch (e) {
        this.logger.error(
          e,
          'Error firing stream plugin %s',
          plugin.constructor.name,
        );
      }
    }

    return Result.success(sessionResult);
  }

  private async setupOfflineItem(
    lineupItem: OfflineStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.targetChannel,
    );

    let duration = dayjs.duration(lineupItem.streamDuration);
    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    if (+duration > +start) {
      duration = duration.subtract(start);
    }

    this.logger.debug(
      'starting offline session of %d ms',
      duration.asMilliseconds(),
    );

    const result = await ffmpeg.createPlaceholderSession({
      kind: 'offline',
      duration,
      outputFormat: this.outputFormat,
      ptsOffset: this.opts?.ptsOffset,
      realtime: this.opts?.realtime,
    });

    if (isUndefined(result)) {
      throw new Error('Unable to start ffmpeg transcode session');
    }

    return Result.success(result);
  }

  private async setupErrorItem(
    lineupItem: ErrorStreamLineupItem,
  ): Promise<Result<TranscodeSessionResult>> {
    const ffmpeg = this.ffmpegFactory(
      this.context.transcodeConfig,
      this.context.targetChannel,
    );

    let duration = dayjs.duration(lineupItem.streamDuration);
    const start = dayjs.duration(lineupItem.startOffset ?? 0);
    if (+duration > +start) {
      duration = duration.subtract(start);
    }

    this.logger.debug(
      'starting offline session of %d ms',
      duration.asMilliseconds(),
    );

    const result = await ffmpeg.createPlaceholderSession({
      kind: 'error',
      title: 'Error',
      duration,
      outputFormat: this.outputFormat,
      realtime: this.opts?.realtime,
      ptsOffset: this.opts?.ptsOffset,
    });

    if (isUndefined(result)) {
      throw new Error('Unable to start ffmpeg transcode session');
    }

    return Result.success(result);
  }

  isInitialized(): boolean {
    return isDefined(this._transcodeSession);
  }

  async start(sink?: PassThrough) {
    this.lifetime.signal.throwIfAborted();
    this.context.playbackSignal?.throwIfAborted();
    if (!this.isInitialized()) {
      const setup = await this.setup();
      if (setup.isFailure()) {
        this.outStream = sink ?? new PassThrough();
        this.hadError = true;
        await this.tryReplaceWithErrorStream(this.outStream);
        return this.outStream;
      }
    }

    this.lifetime.signal.throwIfAborted();
    this.context.playbackSignal?.throwIfAborted();
    return (this.outStream = this._transcodeSession?.start(sink, false));
  }

  async wait() {
    while (this._transcodeSession) {
      const current = this._transcodeSession;
      const exit = await current.wait();
      await this.replacement;
      if (this._transcodeSession === current || this.lifetime.signal.aborted) {
        return exit;
      }
    }
    return;
  }

  shutdown(): void {
    this.lifetime.abort();
    this.context.playbackSignal?.removeEventListener(
      'abort',
      this.contextAbort,
    );
    this.mediaAttempt?.abort();
    if (this.isInitialized()) {
      this.transcodeSession!.kill();
    }
    this.shutdownInternal();
  }

  protected shutdownInternal(): void {}

  get renditions(): StreamRenditions | undefined {
    return this._renditions;
  }

  get transcodeSession(): Maybe<FfmpegTranscodeSession> {
    return this._transcodeSession;
  }

  set transcodeSession(session: FfmpegTranscodeSession) {
    this._transcodeSession = session;
    const attempt = this.mediaAttempt;
    this._transcodeSession.on('end', () => {
      attempt?.abort();
      this.shutdownInternal();
      if (this._transcodeSession === session) {
        const shortfall = this.shortfallMs;
        this.shortfallMs = 0;
        this.replaceStream(this.completeSession(session, shortfall));
      }
    });
    this._transcodeSession.on('error', () => {
      attempt?.abort();
      if (this._transcodeSession !== session || this.lifetime.signal.aborted) {
        return;
      }
      if (this.hadError) {
        // We're streaming the error and something went wrong with that..
        // time to just bail.
        this.shutdown();
        this.emit('error');
      } else {
        this.hadError = true;
        const failedStream = this._transcodeSession;
        failedStream?.kill();
        if (!this.opts?.disableErrorStream) {
          this.replaceStream(this.tryReplaceWithErrorStream(this.outStream));
        }
      }
    });
  }

  private replaceStream(operation: Promise<void>) {
    this.replacement = operation.catch((error) => {
      this.logger.error(error, 'Could not replace the playback stream');
      this.shutdown();
      this.outStream?.push(null);
      this.emit('error');
    });
  }

  private async completeSession(
    session: FfmpegTranscodeSession,
    shortfall: number,
  ) {
    const output = session.process.stdout;
    if (output && !output.readableEnded && !output.destroyed) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          output.removeListener('end', finish);
          output.removeListener('close', finish);
          output.removeListener('error', finish);
          resolve();
        };
        output.once('end', finish);
        output.once('close', finish);
        output.once('error', finish);
      });
    }
    if (this._transcodeSession !== session) {
      return;
    }
    if (
      shortfall > 0 &&
      !this.lifetime.signal.aborted &&
      !this.context.playbackSignal?.aborted
    ) {
      this.hadError = true;
      await this.tryReplaceWithErrorStream(this.outStream, shortfall);
    } else {
      this.outStream?.push(null);
      this.context.playbackSignal?.removeEventListener(
        'abort',
        this.contextAbort,
      );
    }
  }

  private async tryReplaceWithErrorStream(
    sink?: PassThrough,
    durationMs?: number,
  ) {
    this.shortfallMs = 0;
    const out = sink ?? new PassThrough();
    try {
      const errorResult = await this.getErrorStream(this.context, durationMs);
      if (
        this.lifetime.signal.aborted ||
        this.context.playbackSignal?.aborted
      ) {
        errorResult?.session.kill();
        return;
      }

      if (isUndefined(errorResult)) {
        out.push(null);
        return;
      }

      this.context.playbackSignal?.addEventListener(
        'abort',
        this.contextAbort,
        { once: true },
      );
      this.transcodeSession = errorResult.session;
      this.transcodeSession.start(out, false);
    } catch (e) {
      this.logger.error(e, 'Error while trying to spawn error stream! YIKES');
      throw e;
    }
  }

  private getErrorStream(context: PlayerContext, durationMs?: number) {
    const ffmpeg = this.ffmpegFactory(
      context.transcodeConfig,
      context.sourceChannel,
    );

    const plannedEnd =
      (context.playbackStartTimeMs ?? Date.now()) +
      context.lineupItem.streamDuration;
    const duration = dayjs.duration(
      durationMs ?? Math.max(0, plannedEnd - Date.now()),
    );

    return ffmpeg.createPlaceholderSession({
      kind: 'error',
      title: 'Playback Error',
      subtitle: 'Check server logs for details',
      duration,
      outputFormat: this.outputFormat,
      realtime: context.realtime,
      ptsOffset: this.opts?.ptsOffset,
    });
  }

  protected async getWatermark(): Promise<Maybe<Watermark>> {
    return this.watermarkResolver.resolve({
      channel: this.context.targetChannel,
      transcodeConfig: this.context.transcodeConfig,
      lineupItem: this.context.lineupItem,
    });
  }
}
