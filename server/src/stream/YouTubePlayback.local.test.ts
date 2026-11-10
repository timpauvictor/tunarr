import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { Container } from 'inversify';
import { expect, test } from 'vitest';
import { FfmpegSettingsSchema } from '@tunarr/types/schemas';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.js';
import type { TranscodeConfigOrm } from '../db/schema/TranscodeConfig.js';
import type { ChannelOrm } from '../db/schema/Channel.js';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.js';
import { FfmpegInfo } from '../ffmpeg/ffmpegInfo.ts';
import { FfmpegStreamFactory } from '../ffmpeg/FfmpegStreamFactory.ts';
import type { StreamSelector } from '../ffmpeg/StreamSelector.ts';
import { FfmpegPipelineBuilderModule } from '../ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import type { PipelineBuilderFactory } from '../ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import { MpegTsOutputFormat } from '../ffmpeg/builder/constants.ts';
import { FeatureFlagService } from '../services/FeatureFlagService.ts';
import { KEYS } from '../types/inject.ts';
import { YouTubeMediaRelay } from './YouTubeMediaRelay.ts';
import { toPlayoutItem } from './etv/EtvNextPlayoutItemMapper.ts';
import { toChannelConfig } from './etv/EtvNextChannelConfigMapper.ts';
import { EtvNextWorkspace } from './etv/EtvNextWorkspace.ts';
import type { StreamDetails } from './types.ts';

dayjs.extend(duration);
const worker = process.env.TUNARR_TEST_ETV_NEXT;
const ffmpeg = process.env.TUNARR_TEST_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.TUNARR_TEST_FFPROBE ?? 'ffprobe';

// Async execution is required: the same event loop serves the range relay.
async function run(
  file: string,
  args: string[],
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<Buffer> {
  const child = spawn(file, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let stderr = '',
    bytes = 0;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        )
          throw error;
      }
    }
  };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) stop();
    else chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  try {
    const [code] = await once(child, 'close');
    if (code !== 0)
      throw new Error(
        `Fixture process failed (${code}): ${stderr.replace(/(Authorization:\s*Bearer\s+)[0-9a-f]+/gi, '$1REDACTED')}`,
      );
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stop();
  }
}

const config: TranscodeConfigOrm = {
  uuid: 'fixture-tc',
  name: 'Fixture',
  threadCount: 1,
  hardwareAccelerationMode: 'none',
  vaapiDriver: 'system',
  vaapiDevice: null,
  resolution: { widthPx: 160, heightPx: 90 },
  videoFormat: 'h264',
  videoProfile: null,
  videoPreset: 'ultrafast',
  videoBitDepth: 8,
  videoBitRate: 500,
  videoBufferSize: 1000,
  audioChannels: 2,
  audioFormat: 'aac',
  audioBitRate: 128,
  audioBufferSize: 256,
  audioSampleRate: 48,
  audioVolumePercent: 100,
  audioLoudnormConfig: null,
  normalizeFrameRate: false,
  deinterlaceVideo: false,
  disableChannelOverlay: false,
  errorScreen: 'pic',
  errorScreenAudio: 'silent',
  isDefault: false,
  disableHardwareDecoder: false,
  disableHardwareEncoding: false,
  disableHardwareFilters: false,
};

test.skipIf(!worker)(
  'real FFmpeg and pinned worker seek split inputs through the guarded relay with aligned markers',
  async () => {
    const base = path.resolve(process.cwd(), '../config/youtube-spike');
    await fs.mkdir(base, { recursive: true });
    const directory = await fs.mkdtemp(path.join(base, 'split-'));
    await fs.chmod(directory, 0o700);
    const owner = new AbortController();
    const owners = [owner];
    const upstreamRequests: { input: string; range: string | undefined }[] = [];
    let cancelOnNextRequest: AbortController | undefined;
    const relay = new YouTubeMediaRelay(
      async (url, _method, headers, signal) => {
        expect(headers['user-agent']).toBe('split-fixture');
        const input = url.pathname === '/video' ? 'video.mp4' : 'audio.m4a';
        const file = path.join(directory, input);
        const size = (await fs.stat(file)).size;
        const match = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
        const start = Number(match?.[1] ?? 0);
        const end = match?.[2]
          ? Math.min(Number(match[2]), size - 1)
          : size - 1;
        upstreamRequests.push({ input, range: headers.range });
        const cancellation = cancelOnNextRequest;
        if (cancellation) {
          cancelOnNextRequest = undefined;
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('Fixture upstream cancelled')),
              { once: true },
            );
            queueMicrotask(() => cancellation.abort());
          });
        }
        const body = createReadStream(file, { start, end, signal });
        return {
          statusCode: match ? 206 : 200,
          headers: {
            'content-type': input.endsWith('.mp4') ? 'video/mp4' : 'audio/mp4',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${size}`,
            'accept-ranges': 'bytes',
          },
          body,
        };
      },
    );
    const server = createServer((request, response) => {
      void relay.handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing relay fixture address');
    const results: Record<string, unknown> = {};
    try {
      await run(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=160x90:r=25:d=4[red];color=lime:s=160x90:r=25:d=4[green];[red][green]concat=n=2:v=1:a=0',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '25',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.join(directory, 'video.mp4'),
      ]);
      await run(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=0.5*sin(2*PI*1000*t)*gte(t\\,4):s=48000:d=8',
        '-vn',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        path.join(directory, 'audio.m4a'),
      ]);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const registerInputs = (signal: AbortSignal) =>
        [
          {
            id: 'picture',
            source: relay.register({
              url: 'https://fixture.googlevideo.com/video',
              headers: { 'User-Agent': 'split-fixture' },
              baseUrl,
              signal,
            }).source,
          },
          {
            id: 'sound',
            source: relay.register({
              url: 'https://fixture.googlevideo.com/audio',
              headers: { 'User-Agent': 'split-fixture' },
              baseUrl,
              signal,
            }).source,
          },
        ] satisfies [unknown, unknown];
      const inputs = registerInputs(owner.signal);
      const details: StreamDetails = {
        duration: dayjs.duration(8000),
        videoDetails: [
          {
            inputId: 'picture',
            codec: 'h264',
            profile: 'Constrained Baseline',
            width: 160,
            height: 90,
            framerate: 25,
            pixelFormat: 'yuv420p',
            bitDepth: 8,
            streamIndex: 0,
            displayAspectRatio: '16:9',
            anamorphic: false,
            bitrate: undefined,
            isAttachedPic: false,
            colorRange: undefined,
            colorSpace: undefined,
            colorTransfer: undefined,
            colorPrimaries: undefined,
          },
        ],
        audioDetails: [
          { inputId: 'sound', codec: 'aac', index: 0, channels: 1 },
        ],
      };
      const audio = details.audioDetails?.[0];
      if (!audio) throw new Error('Missing fixture audio');
      const settings = FfmpegSettingsSchema.parse({
        ffmpegExecutablePath: ffmpeg,
        ffprobeExecutablePath: ffprobe,
        logLevel: 'error',
        enableLogging: false,
        enableFileLogging: false,
      });
      const settingsDB = {
        ffmpegSettings: () => settings,
        systemSettings: () => ({ logging: { logsDirectory: directory } }),
      } as unknown as ISettingsDB;
      const flags = { get: () => false } as unknown as FeatureFlagService;
      const info = new FfmpegInfo(ffmpeg, ffprobe);
      await info.seed();
      const container = new Container();
      container.bind(KEYS.SettingsDB).toConstantValue(settingsDB);
      container.bind(FfmpegInfo).toConstantValue(info);
      container.bind(FeatureFlagService).toConstantValue(flags);
      await container.load(FfmpegPipelineBuilderModule);
      const selector = {
        selectAudioAndSubtitleStreams: async () => ({
          audioStream: audio,
          subtitleStream: null,
        }),
      } as unknown as StreamSelector;
      const channel = {
        uuid: 'fixture-channel',
        name: 'Split fixture',
        number: 999,
        streamMode: 'mpegts',
        subtitlesEnabled: false,
        offline: { mode: 'pic' },
      } as ChannelOrm;
      const lineup = {
        type: 'program',
        program: {},
        programBeginMs: Date.now(),
        startOffset: 3000,
        duration: 8000,
        streamDuration: 2000,
        infiniteLoop: false,
      } as ContentBackedStreamLineupItem;
      const stream = { inputs, details };
      const factory = new FfmpegStreamFactory(
        info,
        settingsDB,
        container.get<PipelineBuilderFactory>(KEYS.PipelineBuilderFactory),
        flags,
        selector,
        config,
        channel,
      );
      const session = await factory.createStreamSession({
        stream,
        options: {
          startTime: dayjs.duration(3000),
          duration: dayjs.duration(2000),
          outputFormat: MpegTsOutputFormat,
          realtime: false,
          streamMode: 'mpegts',
        },
        lineupItem: lineup,
      });
      if (!session) throw new Error('No factory session');
      const conventional = path.join(directory, 'conventional.ts');
      await fs.writeFile(
        conventional,
        await run(ffmpeg, session.session.process.args),
      );
      results.ffmpeg = await markers(conventional);

      const workspace = new EtvNextWorkspace(directory, 'fixture');
      await workspace.initialize();
      const startMs = Date.now();
      const mapped = toPlayoutItem({
        id: 'split',
        startMs,
        lineupItem: lineup,
        stream: { ...stream, selection: { audioStream: audio } },
        resolution: config.resolution,
      });
      const channelConfig = toChannelConfig({
        transcodeConfig: config,
        ffmpegSettings: settings,
        playoutFolder: workspace.playoutDirectory,
        reportsFolder: workspace.root,
        subtitleMode: 'burn',
      }).config;
      await workspace.writeChannelConfig(channelConfig);
      await workspace.writePlayoutWindow(startMs, startMs + 2000, [
        mapped.item,
      ]);
      await run(
        worker ?? '',
        [
          'run',
          workspace.channelConfigPath,
          '--output-folder',
          workspace.outputDirectory,
          '--number',
          '999',
          '--troubleshoot',
        ],
        25000,
      );
      results.worker = await markers(
        path.join(workspace.outputDirectory, 'ffmpeg.m3u8'),
      );
      expect(
        upstreamRequests.some(
          (request) => request.input === 'video.mp4' && request.range,
        ),
      ).toBe(true);
      expect(
        upstreamRequests.some(
          (request) => request.input === 'audio.m4a' && request.range,
        ),
      ).toBe(true);
      cancelOnNextRequest = owner;
      const cancelledFfmpeg = await run(
        ffmpeg,
        session.session.process.args,
        15000,
        owner.signal,
      ).then(
        () => false,
        () => true,
      );
      expect(cancelledFfmpeg).toBe(true);
      expect(owner.signal.aborted).toBe(true);
      await expect.poll(() => relay.status).toEqual({ inputs: 0, requests: 0 });

      const cancelOwner = new AbortController();
      owners.push(cancelOwner);
      const cancelWorkspace = new EtvNextWorkspace(directory, 'cancel');
      await cancelWorkspace.initialize();
      const cancelStart = Date.now();
      const cancelItem = toPlayoutItem({
        id: 'cancel',
        startMs: cancelStart,
        lineupItem: lineup,
        stream: {
          inputs: registerInputs(cancelOwner.signal),
          details,
          selection: { audioStream: audio },
        },
        resolution: config.resolution,
      });
      await cancelWorkspace.writeChannelConfig(
        toChannelConfig({
          transcodeConfig: config,
          ffmpegSettings: settings,
          playoutFolder: cancelWorkspace.playoutDirectory,
          subtitleMode: 'burn',
        }).config,
      );
      await cancelWorkspace.writePlayoutWindow(
        cancelStart,
        cancelStart + 2000,
        [cancelItem.item],
      );
      cancelOnNextRequest = cancelOwner;
      const cancelledWorker = await run(
        worker ?? '',
        [
          'run',
          cancelWorkspace.channelConfigPath,
          '--output-folder',
          cancelWorkspace.outputDirectory,
          '--number',
          '999',
          '--troubleshoot',
        ],
        25000,
        cancelOwner.signal,
      ).then(
        () => false,
        () => true,
      );
      expect(cancelledWorker).toBe(true);
      expect(cancelOwner.signal.aborted).toBe(true);
      await expect.poll(() => relay.status).toEqual({ inputs: 0, requests: 0 });
      results.cancellation = {
        ffmpeg: cancelledFfmpeg,
        worker: cancelledWorker,
        boundary:
          'first upstream read during startup/consumption; owner abort kills the owned process group',
      };
      await fs.writeFile(
        path.join(base, 'packet0-split-receipt.json'),
        JSON.stringify(
          {
            results,
            upstreamRequests,
            toleranceSeconds: 0.04,
            sourceMarkerSeconds: 4,
            requestedSeekSeconds: 3,
            slotSeconds: 2,
            relayAfterCleanup: relay.status,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const scope of owners) scope.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Private worker reports/configs contain live relay capabilities. They are
      // never retained as evidence; only the sanitized numeric receipt remains.
      await fs.rm(directory, { recursive: true, force: true });
    }

    async function markers(file: string) {
      const probe = JSON.parse(
        (
          await run(ffprobe, [
            '-v',
            'error',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            file,
          ])
        ).toString(),
      );
      expect(
        probe.streams.some(
          (stream: { codec_type: string }) => stream.codec_type === 'video',
        ),
      ).toBe(true);
      expect(
        probe.streams.some(
          (stream: { codec_type: string }) => stream.codec_type === 'audio',
        ),
      ).toBe(true);
      const rgb = await run(ffmpeg, [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vf',
        'scale=1:1:flags=neighbor,format=rgb24',
        '-f',
        'rawvideo',
        '-',
      ]);
      let videoTransition = -1;
      for (let frame = 0; frame * 3 + 2 < rgb.length; frame++) {
        if (
          rgb.readUInt8(frame * 3) < 80 &&
          rgb.readUInt8(frame * 3 + 1) > 150
        ) {
          videoTransition = frame / 25;
          break;
        }
      }
      const pcm = await run(ffmpeg, [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        'f32le',
        '-',
      ]);
      let audioTransition = -1;
      for (let sample = 0; sample * 4 + 3 < pcm.length; sample++) {
        if (Math.abs(pcm.readFloatLE(sample * 4)) > 0.1) {
          audioTransition = sample / 48000;
          break;
        }
      }
      expect(videoTransition).toBeGreaterThan(0);
      expect(videoTransition).toBeLessThanOrEqual(1.04);
      expect(audioTransition).toBeGreaterThan(0);
      expect(Math.abs(videoTransition - audioTransition)).toBeLessThanOrEqual(
        0.04,
      );
      const length = Number(probe.format.duration);
      expect(length).toBeGreaterThanOrEqual(1.96);
      expect(length).toBeLessThanOrEqual(2.04);
      return {
        videoTransition,
        audioTransition,
        durationSeconds: length,
        videoFrames: rgb.length / 3,
      };
    }
  },
  60000,
);
