import { afterEach, describe, expect, it, test, vi } from 'vitest';
import dayjs from 'dayjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { ChannelOrmWithTranscodeConfig } from '../db/schema/derivedTypes.ts';
import {
  HlsOutputFormat,
  defaultHlsOptions,
} from '../ffmpeg/builder/constants.ts';
import type { FFmpegAssistedFactory } from '../ffmpeg/FFmpegModule.ts';
import type { FfmpegProcess } from '../ffmpeg/FfmpegProcess.ts';
import { FfmpegTranscodeSession } from '../ffmpeg/FfmpegTrancodeSession.ts';
import type { TranscodeSessionResult } from '../ffmpeg/types.ts';
import { Result } from '../types/result.ts';
import type { WrappedError } from '../types/errors.ts';
import { PlayerContext } from './PlayerStreamContext.ts';
import { ProgramStream } from './ProgramStream.ts';
import type { ProgramStreamDetailsFetcher } from './ProgramStreamDetailsFetcher.ts';
import type { StreamProgramCalculator } from './StreamProgramCalculator.ts';
import type { WatermarkResolver } from './WatermarkResolver.ts';
import { HttpStreamSource, type ProgramStreamResult } from './types.ts';

class ThrowingProgramStream extends ProgramStream {
  protected override setupInternal(): Promise<Result<TranscodeSessionResult>> {
    return Promise.reject(
      new Error('Streams with no video are not currently supported.'),
    );
  }
}

afterEach(() => vi.useRealTimers());

function nativeSession(durationMs: number) {
  const output = new PassThrough();
  let ended = false;
  const process = Object.assign(new EventEmitter(), {
    stdout: output,
    start: () => output,
    kill: vi.fn(() => {
      if (ended) return;
      ended = true;
      output.end();
      process.emit('exit', null, 'SIGTERM');
      process.emit('end');
    }),
  });
  const session = new FfmpegTranscodeSession(
    process as unknown as FfmpegProcess,
    dayjs.duration(durationMs),
    dayjs().add(durationMs, 'milliseconds'),
  );
  const wait = vi.spyOn(session, 'wait');
  return {
    session,
    wait,
    finish(failed = false) {
      ended = true;
      output.end();
      // Match FfmpegProcess: exit precedes end/error, and a failed exited process
      // does not emit a second end when the error handler calls kill().
      process.emit('exit', failed ? 1 : 0, null);
      if (failed) process.emit('error', new Error('Terminal media failure'));
      else process.emit('end');
    },
  };
}

function playbackFixture(mediaDurationMs = 10000, preparationMs = 0) {
  const now = Date.now();
  const owner = new AbortController();
  const channel = {
    uuid: 'channel',
    number: 1,
    transcodeConfig: { resolution: { widthPx: 640, heightPx: 360 } },
  } as unknown as ChannelOrmWithTranscodeConfig;
  const savedItem = {
    type: 'program',
    duration: 10000,
    streamDuration: 10000,
    programBeginMs: now,
    infiniteLoop: false,
    program: {
      uuid: 'program',
      duration: 10000,
      sourceType: 'youtube',
      mediaSourceId: 'source',
    },
  } as unknown as ContentBackedStreamLineupItem;
  const context = new PlayerContext(
    savedItem,
    channel,
    channel,
    channel.transcodeConfig,
    { audioOnly: false, realtime: false, streamMode: 'hls' },
  );
  context.playbackSignal = owner.signal;
  context.playbackStartTimeMs = now;
  context.scheduleTimeMs = now;
  const content = nativeSession(10000),
    placeholder = nativeSession(10000);
  const createStreamSession = vi.fn(async () => ({ session: content.session }));
  const createPlaceholderSession = vi.fn(async () => ({
    session: placeholder.session,
  }));
  const ffmpegFactory = (() => ({
    createStreamSession,
    createPlaceholderSession,
  })) as unknown as FFmpegAssistedFactory;
  const getStream = vi
    .fn<ProgramStreamDetailsFetcher['getStream']>()
    .mockImplementation(async () => {
      if (preparationMs) vi.setSystemTime(now + preparationMs);
      return Result.success<ProgramStreamResult, WrappedError>({
        inputs: [
          {
            id: 'video',
            source: new HttpStreamSource('http://127.0.0.1/fixture'),
          },
        ],
        streamDetails: {
          duration: dayjs.duration(mediaDurationMs),
          videoDetails: [
            {
              inputId: 'video',
              width: 640,
              height: 360,
              codec: 'h264',
              profile: undefined,
              framerate: 30,
              pixelFormat: 'yuv420p',
              bitDepth: 8,
              streamIndex: 0,
              displayAspectRatio: '16:9',
              anamorphic: false,
              bitrate: 1000,
              isAttachedPic: false,
              colorRange: 'tv',
              colorSpace: 'bt709',
              colorTransfer: 'bt709',
              colorPrimaries: 'bt709',
            },
          ],
        },
      });
    });
  const getCurrentLineupItem =
    vi.fn<StreamProgramCalculator['getCurrentLineupItem']>();
  const stream = new ProgramStream(
    {} as ISettingsDB,
    { resolve: async () => undefined } as unknown as WatermarkResolver,
    ffmpegFactory,
    { getById: async () => ({ type: 'youtube' }) } as unknown as MediaSourceDB,
    { getStream } as unknown as ProgramStreamDetailsFetcher,
    [],
    { getCurrentLineupItem } as unknown as StreamProgramCalculator,
    context,
    HlsOutputFormat(defaultHlsOptions),
  );
  return {
    stream,
    context,
    savedItem,
    channel,
    owner,
    content,
    placeholder,
    getStream,
    getCurrentLineupItem,
    createStreamSession,
    createPlaceholderSession,
  };
}

describe('ProgramStream', () => {
  it('turns a setup throw into a failed result', async () => {
    const stream = new ThrowingProgramStream(
      {} as ISettingsDB,
      {} as WatermarkResolver,
      {} as FFmpegAssistedFactory,
      {} as MediaSourceDB,
      {} as ProgramStreamDetailsFetcher,
      [],
      {} as StreamProgramCalculator,
      {} as PlayerContext,
      HlsOutputFormat(defaultHlsOptions),
    );
    const result = await stream.setup();
    expect(result.isFailure()).toBe(true);
    expect(stream.isInitialized()).toBe(false);
  });

  test('a named diagnostic keeps its selected program rather than following a live schedule during preparation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100000);
    const f = playbackFixture(10000, 11000);
    f.context.playbackStartTimeMs = undefined;
    f.context.scheduleTimeMs = undefined;
    try {
      expect((await f.stream.setup()).isSuccess()).toBe(true);
      expect(f.getCurrentLineupItem).not.toHaveBeenCalled();
      expect(f.createStreamSession).toHaveBeenCalledTimes(1);
      expect(f.getStream.mock.calls[0]?.[0].expiresAt).toBeUndefined();
      expect(f.context.lineupItem).toBe(f.savedItem);
    } finally {
      f.stream.shutdown();
    }
  });

  test('recalculates after an expired preparation even when resolution failed, without starting late media', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100000);
    const f = playbackFixture();
    f.getStream.mockImplementationOnce(async () => {
      vi.setSystemTime(111000);
      return Result.failure('Expired while preparing');
    });
    f.getCurrentLineupItem.mockResolvedValue(
      Result.success({
        lineupItem: {
          type: 'offline',
          duration: 5000,
          streamDuration: 5000,
          programBeginMs: 110000,
        },
        channelContext: f.channel,
        sourceChannel: f.channel,
      }),
    );
    try {
      expect((await f.stream.setup()).isSuccess()).toBe(true);
      expect(f.createStreamSession).not.toHaveBeenCalled();
      expect(f.getCurrentLineupItem).toHaveBeenCalledWith({
        channelId: 'channel',
        startTime: 111000,
        allowSkip: true,
        recordPlayHistory: false,
      });
      expect(f.createPlaceholderSession).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'offline',
          duration: dayjs.duration(5000),
        }),
      );
      expect(f.savedItem.duration).toBe(10000);
      expect(f.savedItem.streamDuration).toBe(10000);
    } finally {
      f.stream.shutdown();
    }
  });

  test.each(['short media', 'terminal failure'] as const)(
    'fills only the remaining saved slot after %s and keeps the sink open',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(100000);
      const f = playbackFixture(kind === 'short media' ? 3000 : 10000);
      try {
        expect((await f.stream.setup()).isSuccess()).toBe(true);
        const sink = await f.stream.start();
        expect(sink).toBeDefined();
        sink?.resume();
        const completion = f.stream.wait();
        const signal = f.getStream.mock.calls[0]?.[0].signal;
        expect(signal?.aborted).toBe(false);
        vi.setSystemTime(kind === 'short media' ? 103000 : 102000);
        f.content.finish(kind === 'terminal failure');
        await expect
          .poll(() => f.createPlaceholderSession.mock.calls.length)
          .toBe(1);
        expect(f.createPlaceholderSession).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'error',
            duration: dayjs.duration(kind === 'short media' ? 7000 : 8000),
          }),
        );
        expect(signal?.aborted).toBe(true);
        expect(sink?.readableEnded).toBe(false);
        const ended = new Promise<void>((resolve) =>
          sink?.once('end', resolve),
        );
        await expect.poll(() => f.placeholder.wait.mock.calls.length).toBe(1);
        f.placeholder.finish();
        await completion;
        await ended;
        expect(f.getStream).toHaveBeenCalledTimes(1);
        expect(f.savedItem.duration).toBe(10000);
        expect(f.savedItem.streamDuration).toBe(10000);
      } finally {
        f.stream.shutdown();
      }
    },
  );
});
