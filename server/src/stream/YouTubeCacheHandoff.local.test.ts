// Explicit local experiment only. No production cache or network-enabled CI test.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { Container } from 'inversify';
import { z } from 'zod';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { FfmpegSettingsSchema } from '@tunarr/types/schemas';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { TranscodeConfigOrm } from '../db/schema/TranscodeConfig.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import { FfmpegInfo } from '../ffmpeg/ffmpegInfo.ts';
import { FfmpegStreamFactory } from '../ffmpeg/FfmpegStreamFactory.ts';
import type { StreamSelector } from '../ffmpeg/StreamSelector.ts';
import { FfmpegPipelineBuilderModule } from '../ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import type { PipelineBuilderFactory } from '../ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import { MpegTsOutputFormat } from '../ffmpeg/builder/constants.ts';
import { FeatureFlagService } from '../services/FeatureFlagService.ts';
import { KEYS } from '../types/inject.ts';
import { FfprobeMediaInfoSchema } from '../types/ffmpeg.ts';
import type { FfprobeMediaInfo } from '../types/ffmpeg.ts';
import {
  YouTubeAdapter,
  YouTubeError,
} from '../external/youtube/YouTubeAdapter.ts';
import type { YouTubeResolvedMedia } from '../external/youtube/YouTubeAdapter.ts';
import { YouTubeMediaRelay } from './YouTubeMediaRelay.ts';
import type { YouTubeMediaTransport } from './YouTubeMediaRelay.ts';
import { YouTubePlaybackResolver } from './YouTubePlaybackResolver.ts';
import { mediaInputs } from './MediaInputs.ts';
import { HttpStreamSource } from './types.ts';
import type { StreamDetails } from './types.ts';
import {
  audioStreamDetailsFromProbe,
  videoStreamDetailsFromProbe,
} from './FfprobeStreamDetails.ts';

const local = vi.hoisted(() => ({ base: '' }));
vi.mock('../util/serverUtil.ts', () => ({ makeLocalUrl: () => local.base }));
dayjs.extend(duration);
const ffmpeg = process.env.TUNARR_TEST_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.TUNARR_TEST_FFPROBE ?? 'ffprobe';
const cellSize = 65536;
const cacheCap = 64 * 1024 * 1024;
const diskCap = 512 * 1024 * 1024;
const wireCap = 256 * 1024 * 1024;
const liveId = 'aqz-KE-bpKQ';
const children = new Set<number>();
const receipts: Record<string, unknown>[] = [];
let directory = '';
let bodyBytes = 0;
// Carry measured media bytes forward for a bounded rerun; never reset its budget.
const previousLiveBodyBytes = Number(
  process.env.TUNARR_TEST_YOUTUBE_CACHE_PRIOR_BYTES ?? 0,
);
if (
  !Number.isSafeInteger(previousLiveBodyBytes) ||
  previousLiveBodyBytes < 0 ||
  previousLiveBodyBytes > wireCap
)
  throw Error('Invalid prior media byte count');
let liveBodyBytes = previousLiveBodyBytes;
let deterministicPassed = false;
let rejectionGatesPassed = false;
const completedFailureCases = new Set<string>();
let fixtureFiles: Record<string, string> = {};
const manifests = new Map<string, string>();
const controls = new Map<number, Measurement>();
const delayedControls = new Map<number, Measurement>();
const cachedRuns = new Map<number, Measurement[]>();
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const safeError = (error: unknown) =>
  error instanceof Error
    ? error.message
        .replace(/Bearer\s+[0-9a-f]+/gi, 'Bearer REDACTED')
        .replace(/https?:\/\/[^\s"']+/g, 'URL_REDACTED')
        .slice(-2048)
    : 'Unknown experiment error';

const cellSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  file: z.string().regex(/^chunk-[0-9]+-[0-9]+\.bin$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
// The existing probe schema consumes raw ffprobe strings but outputs numbers.
// Normalize only its transformed fields before revalidating a disk round trip.
const storedProbeSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const streams: unknown = Reflect.get(value, 'streams');
  if (!Array.isArray(streams)) return value;
  return {
    ...value,
    streams: streams.map((stream: unknown) => {
      if (!stream || typeof stream !== 'object') return stream;
      const type: unknown = Reflect.get(stream, 'codec_type');
      const rate: unknown = Reflect.get(stream, 'r_frame_rate');
      const bitrate: unknown = Reflect.get(stream, 'bit_rate');
      const avc: unknown = Reflect.get(stream, 'is_avc');
      return {
        ...stream,
        ...(type === 'video' && typeof avc === 'boolean'
          ? { is_avc: String(avc) }
          : {}),
        ...(type === 'video' && typeof rate === 'number'
          ? { r_frame_rate: `${Math.round(rate * 1000000)}/1000000` }
          : {}),
        ...(type === 'audio' && typeof bitrate === 'number'
          ? { bit_rate: String(bitrate) }
          : {}),
      };
    }),
  };
}, FfprobeMediaInfoSchema);
const manifestSchema = z.object({
  version: z.literal(1),
  item: z.string(),
  start: z.number().nonnegative(),
  durationMs: z.number().positive(),
  inputs: z
    .array(
      z.object({
        id: z.string().min(1),
        size: z.number().int().positive(),
        mime: z.string(),
        probe: storedProbeSchema,
        cells: z.array(cellSchema),
      }),
    )
    .min(1),
});
type Manifest = z.infer<typeof manifestSchema>;
type Input = Manifest['inputs'][number];
type Cell = z.infer<typeof cellSchema>;
type Fault = 'changed' | 'changed-audio' | 'range' | 'short' | 'ignore';
type Measurement = {
  firstByteMs: number;
  firstFrameMs: number;
  maxGapMs: number;
  duration: number;
  videoPts: number[];
  ordinals: number[];
  pulseTimes: number[];
  avErrors: number[];
  frameHash: string;
  audioHash: string;
};

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No private port');
  return `http://127.0.0.1:${address.port}/`;
}
async function diskUsage(folder: string): Promise<number> {
  let size = 0;
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const name = path.join(folder, entry.name);
    size += entry.isDirectory()
      ? await diskUsage(name)
      : (await fs.stat(name)).size;
  }
  if (size > diskCap) throw Error('DISK_CAP');
  return size;
}
async function saveReceipt() {
  if (!directory) return;
  await fs.writeFile(
    path.join(directory, 'receipt.json'),
    JSON.stringify(
      {
        schema: 1,
        receipts,
        deterministicPassed,
        bodyBytes,
        liveBodyBytes,
        previousLiveBodyBytes,
        ownedChildren: [...children],
        scope: 'Native MPEG-TS experiment; not HLS/browser/product acceptance',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

// Stream long output. The existing playback fixture's 15s/2MiB helper stays unchanged.
async function native(
  args: string[],
  options: {
    executable?: string;
    signal?: AbortSignal;
    output?: string;
    progress?: boolean;
    onProgress?: (frames: number, time: number) => void;
  } = {},
) {
  const actual = options.progress
    ? ['-progress', 'pipe:3', '-stats_period', '0.1', ...args]
    : args;
  const child = spawn(options.executable ?? ffmpeg, actual, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  const stdout = child.stdout,
    stderrStream = child.stderr;
  if (!pid || !stdout || !stderrStream) throw Error('No native child streams');
  children.add(pid);
  let stderr = '',
    progress = '';
  let firstByteMs = Infinity;
  let firstFrameMs = Infinity,
    lastFrameAt = 0,
    lastFrames = 0,
    maxGapMs = 0;
  const t0 = performance.now();
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        throw error;
    }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    kill('SIGTERM');
    force ??= setTimeout(() => kill('SIGKILL'), 4900);
  };
  const deadline = setTimeout(abort, 75000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  stderrStream.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192);
  });
  child.stdio[3]?.on('data', (data: Buffer) => {
    progress += data.toString();
    let end: number;
    while ((end = progress.indexOf('\n')) >= 0) {
      const line = progress.slice(0, end);
      progress = progress.slice(end + 1);
      if (!line.startsWith('frame=')) continue;
      const frames = Number(line.slice(6));
      const time = performance.now() - t0;
      if (frames > lastFrames) {
        if (firstFrameMs === Infinity) firstFrameMs = time;
        if (lastFrameAt > 0) maxGapMs = Math.max(maxGapMs, time - lastFrameAt);
        lastFrames = frames;
        lastFrameAt = time;
        options.onProgress?.(frames, time);
      }
    }
  });
  let bytes = 0;
  const chunks: Buffer[] = [];
  const output = options.output
    ? await fs.open(options.output, 'w', 0o600)
    : undefined;
  const consume = (async () => {
    for await (const value of stdout) {
      const data: unknown = value;
      if (!Buffer.isBuffer(data)) throw Error('Nonbinary native output');
      const chunk: Buffer = data;
      if (!bytes) firstByteMs = performance.now() - t0;
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        abort();
        throw Error('NATIVE_OUTPUT_CAP');
      }
      if (output) await output.write(chunk);
      else chunks.push(chunk);
    }
  })();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null) => resolve(code));
  });
  try {
    const [code] = await Promise.all([closed, consume]);
    if (code !== 0 || options.signal?.aborted)
      throw Error(`Native stopped ${code}: ${safeError(Error(stderr))}`);
    if (options.output) await diskUsage(directory);
    return {
      data: Buffer.concat(chunks),
      firstByteMs,
      firstFrameMs,
      maxGapMs,
      startedAt: t0,
      elapsedMs: performance.now() - t0,
      bytes,
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    options.signal?.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) {
      abort();
      await closed;
    }
    clearTimeout(force);
    await output?.close();
    children.delete(pid);
  }
}

function cleanProbe(probe: FfprobeMediaInfo) {
  const keys = [
    'index',
    'codec_type',
    'codec_name',
    'profile',
    'width',
    'height',
    'coded_width',
    'coded_height',
    'r_frame_rate',
    'pix_fmt',
    'bits_per_raw_sample',
    'bit_rate',
    'sample_aspect_ratio',
    'display_aspect_ratio',
    'field_order',
    'color_primaries',
    'color_range',
    'color_space',
    'color_transfer',
    'sample_rate',
    'channels',
    'channel_layout',
    'disposition',
  ];
  return storedProbeSchema.parse({
    streams: probe.streams.map((stream) =>
      Object.fromEntries(keys.map((key) => [key, Reflect.get(stream, key)])),
    ),
    format: {
      nb_streams: probe.format.nb_streams,
      format_name: probe.format.format_name,
      duration: probe.format.duration,
      size: probe.format.size,
      bit_rate: probe.format.bit_rate,
    },
  });
}

async function source(
  kind: 'synthetic' | 'provider',
  layout = 'fast',
  waitMs = 0,
  fault?: Fault,
) {
  const owner = new AbortController();
  const lifetime = setTimeout(() => owner.abort(), 75000);
  let calls = 0,
    oldCalls = 0,
    outstanding = 0;
  const transport: YouTubeMediaTransport = async (
    url,
    method,
    headers,
    signal,
  ) => {
    if (owner.signal.aborted) oldCalls++;
    calls++;
    outstanding++;
    const file = fixtureFiles[`${layout}:${url.pathname.slice(1)}`];
    if (!file) throw Error('Unknown fixture input');
    const size = (await fs.stat(file)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '');
    const start = Number(range?.[1] ?? 0),
      end = Math.min(Number(range?.[2] || size - 1), size - 1);
    if (start > end) throw Error('Invalid fixture range');
    const body = Readable.from(
      (async function* () {
        const handle = await fs.open(file, 'r');
        try {
          if (method === 'HEAD') return;
          let position = start;
          const flip = url.pathname === '/sound' ? 131072 : 2097152;
          while (position <= end) {
            signal.throwIfAborted();
            const length = Math.min(cellSize, end - position + 1);
            const data = Buffer.alloc(length);
            await handle.read(data, 0, length, position);
            if (
              (fault === 'changed' ||
                (fault === 'changed-audio' && url.pathname === '/sound')) &&
              flip >= position &&
              flip < position + length
            )
              data[flip - position] = (data[flip - position] ?? 0) ^ 1;
            if (fault === 'short')
              yield data.subarray(0, Math.max(0, data.length - 1));
            else yield data;
            position += length;
          }
        } finally {
          await handle.close();
        }
      })(),
    );
    const abort = () => body.destroy();
    signal.addEventListener('abort', abort, { once: true });
    body.once('close', () => {
      outstanding--;
      signal.removeEventListener('abort', abort);
    });
    return {
      statusCode: fault === 'ignore' ? 200 : range ? 206 : 200,
      headers: {
        'content-type': url.pathname === '/sound' ? 'audio/mp4' : 'video/mp4',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${fault === 'range' ? start + 1 : start}-${end}/${size}`,
      },
      body,
    };
  };
  const relay =
    kind === 'synthetic'
      ? new YouTubeMediaRelay(transport)
      : new YouTubeMediaRelay();
  const server = createServer((req, res) => {
    // Count actual forwarded media bodies, including resolver probes, without a global HTTPS patch.
    const write = res.write.bind(res);
    res.write = (
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk))
        throw Error('Nonbinary media body');
      const length =
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bodyBytes += length;
      if (kind === 'provider') {
        liveBodyBytes += length;
        if (liveBodyBytes > wireCap) {
          owner.abort();
          res.destroy();
          return false;
        }
      }
      return typeof encodingOrCallback === 'function'
        ? write(chunk, encodingOrCallback)
        : write(chunk, encodingOrCallback ?? 'utf8', callback);
    };
    void relay.handle(req, res);
  });
  const base = await listen(server);
  local.base = base;
  const adapter = new YouTubeAdapter();
  let ids: string[] = [],
    probeIndex = 0;
  const probes = new Map<string, FfprobeMediaInfo>();
  const settings = {
    ffmpegSettings: () => ({ ffprobeExecutablePath: ffprobe }),
  } as ISettingsDB;
  const resolver = new YouTubePlaybackResolver(
    {
      resolve: async (
        videoId: string,
        maxHeight: number,
        signal: AbortSignal,
      ) => {
        if (waitMs) await delay(waitMs, undefined, { signal });
        const media: YouTubeResolvedMedia =
          kind === 'provider'
            ? await adapter.resolve(videoId, maxHeight, signal)
            : {
                durationSeconds: 180,
                inputs: ['picture', 'sound'].map((id) => ({
                  id,
                  url: `https://fixture.googlevideo.com/${id}?generation=${randomBytes(4).toString('hex')}`,
                  headers: { 'User-Agent': 'cache-fixture' },
                })),
              };
        if (!ids.length) ids = media.inputs.map((input) => input.id);
        return media;
      },
      probe: async (...args) => {
        const probe = await adapter.probe(...args);
        const id = ids[probeIndex++];
        if (!id) throw Error('Unexpected probe');
        probes.set(id, cleanProbe(probe));
        return probe;
      },
    },
    relay,
    settings,
  );
  const started = performance.now();
  const ready = resolver
    .resolve(liveId, owner.signal, 720)
    .then(async (result) => {
      const inputs: {
        id: string;
        source: HttpStreamSource;
        size: number;
        mime: string;
      }[] = [];
      for (const input of mediaInputs(result)) {
        if (input.source.type !== 'http') throw Error('HTTP input required');
        const response = await fetch(input.source.path, {
          headers: { ...input.source.extraHeaders, range: 'bytes=0-0' },
          signal: owner.signal,
        });
        const range = /^bytes 0-0\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.status !== 206 || !range || bytes.length !== 1)
          throw Error('SOURCE_RANGE_METADATA');
        inputs.push({
          id: input.id,
          source: input.source,
          size: Number(range[1]),
          mime:
            response.headers.get('content-type') ?? 'application/octet-stream',
        });
      }
      return { result, inputs, readyMs: performance.now() - started };
    });
  void ready.catch(() => {});
  let closing:
    | Promise<{
        calls: number;
        oldCalls: number;
        outstanding: number;
        relay: { inputs: number; requests: number };
      }>
    | undefined;
  return {
    ready,
    probes,
    owner,
    relay,
    base,
    close() {
      return (closing ??= (async () => {
        clearTimeout(lifetime);
        owner.abort();
        await ready.catch(() => {});
        await closeServer(server);
        const deadline = performance.now() + 5000;
        while (
          (relay.status.inputs || relay.status.requests || outstanding) &&
          performance.now() < deadline
        )
          await delay(10);
        expect(relay.status).toEqual({ inputs: 0, requests: 0 });
        expect(oldCalls).toBe(0);
        expect(outstanding).toBe(0);
        return { calls, oldCalls, outstanding, relay: relay.status };
      })());
    },
  };
}
type Source = Awaited<ReturnType<typeof source>>;

async function rangeRead(
  input: { source: HttpStreamSource; size: number },
  start: number,
  end: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(input.source.path, {
    headers: { ...input.source.extraHeaders, range: `bytes=${start}-${end}` },
    signal,
  });
  const actual = response.headers.get('content-range');
  if (
    response.status !== 206 ||
    actual !== `bytes ${start}-${end}/${input.size}` ||
    Number(response.headers.get('content-length')) !== end - start + 1
  ) {
    await response.body?.cancel();
    throw Error('INVALID_RANGE');
  }
  const data = Buffer.from(await response.arrayBuffer());
  signal.throwIfAborted();
  if (data.length !== end - start + 1) throw Error('SHORT_RANGE');
  return data;
}
async function readCell(folder: string, cell: Cell) {
  const data = await fs.readFile(path.join(folder, cell.file));
  if (data.length !== cell.end - cell.start + 1 || hash(data) !== cell.sha256)
    throw Error('CORRUPT_CACHE');
  return data;
}
async function loadManifest(file: string) {
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(file, 'utf8')),
  );
  if (
    new Set(manifest.inputs.map((input) => input.id)).size !==
    manifest.inputs.length
  )
    throw Error('DUPLICATE_INPUT');
  let bytes = 0;
  for (const input of manifest.inputs) {
    let last = -1;
    for (const cell of input.cells) {
      if (
        cell.start <= last ||
        cell.end < cell.start ||
        cell.end >= input.size ||
        cell.end - cell.start >= cellSize
      )
        throw Error('INVALID_CACHE_INTERVAL');
      await readCell(path.dirname(file), cell);
      last = cell.end;
      bytes += cell.end - cell.start + 1;
    }
    if (input.cells.reduce((n, c) => n + c.end - c.start + 1, 0) >= input.size)
      throw Error('FULL_FILE_CACHE');
  }
  if (bytes > cacheCap) throw Error('CACHE_CAP');
  return manifest;
}
function cachedDetails(manifest: Manifest): StreamDetails {
  const videos = manifest.inputs.flatMap((input) =>
    input.probe.streams.flatMap((track) =>
      track.codec_type === 'video'
        ? [{ ...videoStreamDetailsFromProbe(track), inputId: input.id }]
        : [],
    ),
  );
  const audios = manifest.inputs.flatMap((input) =>
    input.probe.streams.flatMap((track) =>
      track.codec_type === 'audio'
        ? [{ ...audioStreamDetailsFromProbe(track), inputId: input.id }]
        : [],
    ),
  );
  const [video, ...otherVideos] = videos,
    [audio, ...otherAudios] = audios;
  if (!video) throw Error('No cached video');
  return {
    duration: dayjs.duration(manifest.durationMs),
    videoDetails: [video, ...otherVideos],
    audioDetails: audio ? [audio, ...otherAudios] : undefined,
  };
}

async function bridge(
  manifest: Manifest,
  folder: string,
  fresh: Source,
  useCache: boolean,
  capture = false,
) {
  const owner = new AbortController();
  const token = randomBytes(32).toString('hex');
  const counts = new Map(
    manifest.inputs.map((input) => [
      input.id,
      {
        cached: 0,
        fresh: 0,
        validation: 0,
        firstMissMs: -1,
        firstMissOffset: -1,
        firstMissRange: '',
      },
    ]),
  );
  const captured = new Map<string, Cell>();
  const start = performance.now();
  let cacheBytes = 0,
    validationMs = -1,
    freshReadyAt = Infinity;
  const pending = new Set<Promise<void>>();
  const compatible = (async () => {
    const resolved = await fresh.ready;
    freshReadyAt = performance.now();
    owner.signal.throwIfAborted();
    if (
      resolved.result.streamDetails.duration?.asMilliseconds() !==
        manifest.durationMs ||
      resolved.inputs.length !== manifest.inputs.length ||
      resolved.inputs.some(
        (input) =>
          !manifest.inputs.some(
            (old) => old.id === input.id && old.size === input.size,
          ),
      )
    )
      throw Error('REPRESENTATION_CHANGED');
    if (useCache)
      for (const old of manifest.inputs) {
        const input = resolved.inputs.find(
          (candidate) => candidate.id === old.id,
        );
        if (!input) throw Error('INPUT_CHANGED');
        for (const cell of old.cells) {
          const saved = await readCell(folder, cell);
          const data = await rangeRead(
            input,
            cell.start,
            cell.end,
            owner.signal,
          );
          const count = counts.get(old.id);
          if (!count) throw Error('No input counter');
          count.validation += data.length;
          if (!data.equals(saved)) throw Error('CACHE_MISMATCH');
        }
      }
    validationMs = performance.now() - start;
    return resolved;
  })();
  void compatible.catch(() => {});
  const server = createServer((req, res) => {
    const task = handle(
      req.url ?? '',
      req.headers.authorization,
      req.headers.range,
      req.method,
      res,
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  const base = await listen(server);
  async function handle(
    url: string,
    authorization: string | undefined,
    range: string | undefined,
    method: string | undefined,
    res: ServerResponse,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    owner.signal.addEventListener('abort', abort, { once: true });
    res.once('close', abort);
    try {
      const index = /^\/cache\/(\d+)$/.exec(url);
      const input = index ? manifest.inputs[Number(index[1])] : undefined;
      if (authorization !== `Bearer ${token}` || !input) {
        res.writeHead(404).end();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : undefined;
      if (range && !match) {
        res.writeHead(416).end();
        return;
      }
      const startOffset = Number(match?.[1] ?? 0),
        endOffset = Math.min(
          Number(match?.[2] || input.size - 1),
          input.size - 1,
        );
      if (startOffset > endOffset) {
        res.writeHead(416).end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        'content-type': input.mime,
        'content-length': endOffset - startOffset + 1,
        ...(range
          ? {
              'content-range': `bytes ${startOffset}-${endOffset}/${input.size}`,
            }
          : {}),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const count = counts.get(input.id);
      if (!count) throw Error('No counter');
      for (let position = startOffset; position <= endOffset; ) {
        controller.signal.throwIfAborted();
        const blockStart = Math.floor(position / cellSize) * cellSize;
        const blockEnd = Math.min(blockStart + cellSize - 1, input.size - 1);
        const cached = useCache
          ? input.cells.find((cell) => cell.start === blockStart)
          : capture
            ? captured.get(`${manifest.inputs.indexOf(input)}-${blockStart}`)
            : undefined;
        let data: Buffer;
        if (cached) data = await readCell(folder, cached);
        else {
          if (count.firstMissMs < 0) {
            count.firstMissMs = performance.now() - start;
            count.firstMissOffset = blockStart;
            count.firstMissRange = range ?? 'full';
          }
          const resolved = await compatible;
          controller.signal.throwIfAborted();
          const lease = resolved.inputs.find(
            (candidate) => candidate.id === input.id,
          );
          if (!lease) throw Error('Fresh input missing');
          data = await rangeRead(
            lease,
            blockStart,
            blockEnd,
            controller.signal,
          );
          if (capture) {
            const key = `${manifest.inputs.indexOf(input)}-${blockStart}`;
            if (!captured.has(key)) {
              cacheBytes += data.length;
              if (cacheBytes > cacheCap) throw Error('CACHE_CAP');
              const file = `chunk-${key}.bin`;
              await fs.writeFile(path.join(folder, file), data, {
                mode: 0o600,
              });
              controller.signal.throwIfAborted();
              captured.set(key, {
                start: blockStart,
                end: blockEnd,
                file,
                sha256: hash(data),
              });
            }
          }
        }
        controller.signal.throwIfAborted();
        const part = data.subarray(
          position - blockStart,
          Math.min(blockEnd, endOffset) - blockStart + 1,
        );
        if (cached) count.cached += part.length;
        else count.fresh += part.length;
        if (!res.write(part))
          await once(res, 'drain', { signal: controller.signal });
        position += part.length;
      }
      res.end();
    } catch {
      res.destroy();
    } finally {
      owner.signal.removeEventListener('abort', abort);
      res.removeListener('close', abort);
    }
  }
  const inputs = manifest.inputs.map((input, index) => ({
    id: input.id,
    source: new HttpStreamSource(`${base}cache/${index}`, {
      Authorization: `Bearer ${token}`,
    }),
  }));
  const [first, ...rest] = inputs;
  if (!first) throw Error('No cache inputs');
  const streamInputs: ReturnType<typeof mediaInputs> = [first, ...rest];
  let closing: Promise<Awaited<ReturnType<Source['close']>>> | undefined;
  return {
    owner,
    inputs: streamInputs,
    compatible,
    stats: () => ({
      counts: Object.fromEntries(counts),
      validationMs,
      freshReadyAt,
      cacheBytes,
    }),
    captured,
    close() {
      return (closing ??= (async () => {
        owner.abort();
        fresh.owner.abort();
        await closeServer(server);
        await Promise.all(pending);
        await compatible.catch(() => {});
        return fresh.close();
      })());
    },
  };
}

const profile: TranscodeConfigOrm = {
  uuid: 'cache-experiment',
  name: 'Cache experiment',
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
let info: FfmpegInfo;
let settings: ISettingsDB;
let container: Container;
const flags = { get: () => false } as unknown as FeatureFlagService;
async function playback(
  manifest: Manifest,
  inputBridge: Awaited<ReturnType<typeof bridge>>,
  name: string,
  seconds = 40,
) {
  const details = cachedDetails(manifest),
    audio = details.audioDetails?.[0];
  if (!audio) throw Error('No cached audio');
  const selector = {
    selectAudioAndSubtitleStreams: () =>
      Promise.resolve({
        audioStream: audio,
        subtitleStream: null,
      }),
  } as unknown as StreamSelector;
  const factory = new FfmpegStreamFactory(
    info,
    settings,
    container.get<PipelineBuilderFactory>(KEYS.PipelineBuilderFactory),
    flags,
    selector,
    profile,
    {
      uuid: 'cache-channel',
      name: 'Cache experiment',
      number: 999,
      streamMode: 'mpegts',
      subtitlesEnabled: false,
      offline: { mode: 'pic' },
    } as ChannelOrm,
  );
  const session = await factory.createStreamSession({
    stream: { inputs: inputBridge.inputs, details },
    options: {
      startTime: dayjs.duration(manifest.start, 'seconds'),
      duration: dayjs.duration(seconds, 'seconds'),
      outputFormat: MpegTsOutputFormat,
      realtime: true,
      streamMode: 'mpegts',
    },
    lineupItem: {
      type: 'program',
      program: {},
      programBeginMs: Date.now(),
      startOffset: manifest.start * 1000,
      duration: (manifest.start + seconds) * 1000,
      streamDuration: seconds * 1000,
      infiniteLoop: false,
    } as ContentBackedStreamLineupItem,
  });
  if (!session) throw Error('No native factory session');
  const args = session.session.process.args;
  for (const index of args.flatMap((arg, i) =>
    arg === '-readrate' ? [i] : [],
  ))
    expect(args[index + 1]).toBe('1');
  expect(args).not.toContain('-readrate_initial_burst');
  const output = path.join(directory, `${name}.ts`);
  const run = await native(args, {
    signal: inputBridge.owner.signal,
    output,
    progress: true,
  });
  return { ...run, output };
}

async function analyse(
  output: string,
  start: number,
  progress: { firstByteMs: number; firstFrameMs: number; maxGapMs: number },
  synthetic = true,
): Promise<Measurement> {
  const frameData = await native(
    [
      '-v',
      'error',
      '-show_frames',
      '-show_entries',
      'frame=media_type,best_effort_timestamp_time',
      '-of',
      'json',
      output,
    ],
    { executable: ffprobe },
  );
  const parsed = z
    .object({
      frames: z.array(
        z.object({
          media_type: z.string(),
          best_effort_timestamp_time: z.coerce.number(),
        }),
      ),
    })
    .parse(JSON.parse(frameData.data.toString()));
  const videoPts = parsed.frames
    .filter((frame) => frame.media_type === 'video')
    .map((frame) => frame.best_effort_timestamp_time);
  const audioPts = parsed.frames.find(
    (frame) => frame.media_type === 'audio',
  )?.best_effort_timestamp_time;
  if (!videoPts.length || audioPts === undefined)
    throw Error('No decoded tracks');
  const gray = await native([
    '-v',
    'error',
    '-threads',
    '1',
    '-i',
    output,
    '-an',
    '-vf',
    synthetic ? 'format=gray' : 'scale=16:16,format=gray',
    '-pix_fmt',
    'gray',
    '-threads',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  const pcm = await native([
    '-v',
    'error',
    '-threads',
    '1',
    '-i',
    output,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  const ordinals: number[] = [],
    pulseTimes: number[] = [];
  if (synthetic)
    for (let offset = 0; offset < gray.data.length; offset += 160 * 90) {
      let ordinal = 0;
      for (let bit = 0; bit < 13; bit++)
        if ((gray.data[offset + 5 * 160 + bit * 10 + 5] ?? 0) > 128)
          ordinal += 2 ** bit;
      ordinals.push(ordinal);
    }
  let wasOn = false;
  for (let offset = 0; offset + 480 * 4 <= pcm.data.length; offset += 480 * 4) {
    let energy = 0;
    for (let sample = 0; sample < 480; sample++)
      energy += pcm.data.readFloatLE(offset + sample * 4) ** 2;
    const on = Math.sqrt(energy / 480) > 0.08;
    if (on && !wasOn) pulseTimes.push(audioPts + offset / (48000 * 4));
    wasOn = on;
  }
  const first = videoPts[0];
  if (first === undefined) throw Error('No first frame');
  const expectedPulses = [29.8, 30.2, 107.1, 107.5].filter(
    (time) => time >= start && time < start + 40,
  );
  const sourceFirst = (ordinals[0] ?? Math.round(start * 25)) / 25;
  const avErrors = synthetic
    ? expectedPulses.map((time, index) =>
        Math.abs(
          (pulseTimes[index] ?? Infinity) - (first + time - sourceFirst),
        ),
      )
    : [];
  return {
    firstByteMs: progress.firstByteMs,
    firstFrameMs: progress.firstFrameMs,
    maxGapMs: progress.maxGapMs,
    duration:
      (videoPts.at(-1) ?? first) -
      first +
      ((videoPts[1] ?? first + 0.04) - first),
    videoPts,
    ordinals,
    pulseTimes,
    avErrors,
    frameHash: hash(gray.data),
    audioHash: hash(pcm.data),
  };
}
function continuity(measurement: Measurement, start: number) {
  expect(
    Math.abs((measurement.ordinals[0] ?? Infinity) - start * 25),
  ).toBeLessThanOrEqual(1);
  for (let i = 1; i < measurement.ordinals.length; i++)
    expect(measurement.ordinals[i]).toBe(
      (measurement.ordinals[i - 1] ?? 0) + 1,
    );
  for (let i = 1; i < measurement.videoPts.length; i++)
    expect(
      Math.abs(
        (measurement.videoPts[i] ?? 0) -
          (measurement.videoPts[i - 1] ?? 0) -
          0.04,
      ),
    ).toBeLessThan(0.00001);
  expect(Math.abs(measurement.duration - 40)).toBeLessThanOrEqual(0.040001);
  expect(measurement.avErrors).toHaveLength(2);
  for (const error of measurement.avErrors)
    expect(error).toBeLessThanOrEqual(0.04);
}

// Generated MP4 fixtures only: locate complete top-level initialization atoms.
// A tail moov can straddle cells; caching only the last cell is not sufficient.
async function initializationCells(file: string, size: number) {
  const handle = await fs.open(file, 'r');
  const cells = new Set<number>();
  try {
    for (let position = 0; position < size; ) {
      const header = Buffer.alloc(16);
      const read = await handle.read(header, 0, header.length, position);
      if (read.bytesRead < 8) throw Error('Invalid fixture atom header');
      const shortSize = header.readUInt32BE(0),
        type = header.toString('ascii', 4, 8);
      const length =
        shortSize === 1
          ? Number(header.readBigUInt64BE(8))
          : shortSize || size - position;
      const headerSize = shortSize === 1 ? 16 : 8;
      if (
        !Number.isSafeInteger(length) ||
        length < headerSize ||
        position + length > size
      )
        throw Error('Invalid fixture atom length');
      const needed = type === 'mdat' ? headerSize : length;
      if (needed > 1024 * 1024) throw Error('Fixture initialization cap');
      for (
        let offset = Math.floor(position / cellSize) * cellSize;
        offset < position + needed;
        offset += cellSize
      )
        cells.add(offset);
      position += length;
    }
    return cells;
  } finally {
    await handle.close();
  }
}

async function prepareSynthetic(layout: string, start: number) {
  const fresh = await source('synthetic', layout);
  const folder = path.join(directory, `cache-${layout}-${start}`);
  await fs.mkdir(folder, { mode: 0o700 });
  try {
    const resolved = await fresh.ready;
    const inputs: Input[] = [];
    let bytes = 0;
    for (const [index, input] of resolved.inputs.entries()) {
      const origin = fixtureFiles[`${layout}:${input.id}`];
      if (!origin) throw Error('No origin');
      const result = await native(
        [
          '-v',
          'error',
          '-show_packets',
          '-show_entries',
          'packet=pts_time,pos,size',
          '-of',
          'json',
          origin,
        ],
        { executable: ffprobe },
      );
      const packets = z
        .object({
          packets: z.array(
            z.object({
              pts_time: z.coerce.number(),
              pos: z.coerce.number(),
              size: z.coerce.number(),
            }),
          ),
        })
        .parse(JSON.parse(result.data.toString()));
      const starts = new Set([
        0,
        Math.floor((input.size - 1) / cellSize) * cellSize,
      ]);
      // Native format probing precedes input seeking: retain one initial GOP
      // as declared initialization data, not a larger active media window.
      for (const packet of packets.packets)
        if (
          packet.pts_time < 2 ||
          (packet.pts_time >= Math.floor(start / 2) * 2 &&
            packet.pts_time < start + 30)
        ) {
          for (
            let position = Math.floor(packet.pos / cellSize) * cellSize;
            position < packet.pos + packet.size;
            position += cellSize
          )
            starts.add(position);
        }
      const initCells = await initializationCells(origin, input.size);
      for (const offset of initCells) starts.add(offset);
      const cells: Cell[] = [];
      for (const position of [...starts].sort((a, b) => a - b)) {
        const end = Math.min(position + cellSize - 1, input.size - 1),
          data = await rangeRead(input, position, end, fresh.owner.signal);
        bytes += data.length;
        if (bytes > cacheCap) throw Error('CACHE_CAP');
        const file = `chunk-${index}-${position}.bin`;
        await fs.writeFile(path.join(folder, file), data, { mode: 0o600 });
        cells.push({ start: position, end, file, sha256: hash(data) });
      }
      const probe = fresh.probes.get(input.id);
      if (!probe) throw Error('No preparation probe');
      inputs.push({
        id: input.id,
        size: input.size,
        mime: input.mime,
        probe,
        cells,
      });
    }
    const manifest = {
      version: 1,
      item: liveId,
      start,
      durationMs: 180000,
      inputs,
    };
    const file = path.join(folder, 'manifest.json');
    await fs.writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    await loadManifest(file);
    manifests.set(`${layout}:${start}`, file);
    receipts.push({
      phase: 'prepare',
      layout,
      start,
      cacheBytes: bytes,
      inputs: inputs.map((input) => ({
        id: input.id,
        size: input.size,
        cached: input.cells.reduce(
          (n, cell) => n + cell.end - cell.start + 1,
          0,
        ),
      })),
    });
  } finally {
    receipts.push({ phase: 'preparation-cleanup', ...(await fresh.close()) });
  }
}

beforeAll(async () => {
  process.umask(0o077);
  const base = path.resolve(process.cwd(), '../config/youtube-cache-spike');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  directory = await fs.mkdtemp(path.join(base, 'run-'));
  await fs.chmod(directory, 0o700);
  const parsedSettings = FfmpegSettingsSchema.parse({
    ffmpegExecutablePath: ffmpeg,
    ffprobeExecutablePath: ffprobe,
    logLevel: 'error',
    enableLogging: false,
    enableFileLogging: false,
  });
  settings = {
    ffmpegSettings: () => parsedSettings,
    systemSettings: () => ({ logging: { logsDirectory: directory } }),
  } as unknown as ISettingsDB;
  info = new FfmpegInfo(ffmpeg, ffprobe);
  await info.seed();
  container = new Container();
  container.bind(KEYS.SettingsDB).toConstantValue(settings);
  container.bind(FfmpegInfo).toConstantValue(info);
  container.bind(FeatureFlagService).toConstantValue(flags);
  container.load(FfmpegPipelineBuilderModule);
  fixtureFiles = Object.fromEntries(
    ['fast', 'tail'].flatMap((layout) =>
      ['picture', 'sound'].map((id) => [
        `${layout}:${id}`,
        path.join(directory, `${layout}-${id}.mp4`),
      ]),
    ),
  );
  await native([
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    "testsrc2=s=160x90:r=25:d=180,geq=lum='if(lt(Y,12),32+192*mod(floor(N/pow(2,floor(X/10))),2),lum(X,Y))'",
    '-an',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'ultrafast',
    '-g',
    '50',
    '-bf',
    '0',
    '-b:v',
    '2M',
    '-minrate',
    '2M',
    '-maxrate',
    '2M',
    '-bufsize',
    '2M',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    fixtureFiles['fast:picture'] ?? '',
  ]);
  const pulses = [29.8, 30.2, 107.1, 107.5]
    .map((time) => `between(t\\,${time}\\,${time + 0.1})`)
    .join('+');
  await native([
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=0.02*sin(2*PI*300*t)+0.5*sin(2*PI*1000*t)*(${pulses}):s=48000:d=180`,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    fixtureFiles['fast:sound'] ?? '',
  ]);
  for (const id of ['picture', 'sound'])
    await native([
      '-v',
      'error',
      '-i',
      fixtureFiles[`fast:${id}`] ?? '',
      '-c',
      'copy',
      fixtureFiles[`tail:${id}`] ?? '',
    ]);
  for (const start of [0, 77.3]) await prepareSynthetic('fast', start);
  await prepareSynthetic('tail', 0);
  receipts.push({
    phase: 'setup',
    bytes: await diskUsage(directory),
    cacheCellBytes: cellSize,
    sourceSeconds: 180,
    readrate: 1,
    nativeTimeoutMs: 75000,
  });
  await saveReceipt();
}, 90000);

afterAll(async () => {
  await saveReceipt();
  console.log(`Cache handoff receipt: ${directory}/receipt.json`);
  expect(children.size).toBe(0);
  // Only this freshly-created run's media; retain numerical receipt, no signed URLs.
  if (directory)
    for (const entry of await fs.readdir(directory))
      if (entry !== 'receipt.json')
        await fs.rm(path.join(directory, entry), { recursive: true });
});

const cases = [
  { id: 'begin-immediate', start: 0, wait: 0, cache: false },
  {
    id: 'tail-index-cached',
    start: 0,
    wait: 8000,
    cache: true,
    layout: 'tail',
  },
  { id: 'resume-immediate', start: 77.3, wait: 0, cache: false },
  { id: 'resume-delayed', start: 77.3, wait: 8000, cache: false },
  { id: 'resume-cached', start: 77.3, wait: 8000, cache: true },
  { id: 'begin-delayed', start: 0, wait: 8000, cache: false },
  ...[1, 2, 3].map((repeat) => ({
    id: `begin-cached-${repeat}`,
    start: 0,
    wait: 8000,
    cache: true,
  })),
];
let positiveFailed = false;
for (const scenario of cases)
  test(`synthetic ${scenario.id}`, async (context) => {
    if (positiveFailed) {
      context.skip();
      return;
    }
    const file = manifests.get(
      `${scenario.layout ?? 'fast'}:${scenario.start}`,
    );
    if (!file) throw Error('No prepared manifest');
    const manifest = await loadManifest(file),
      fresh = await source(
        'synthetic',
        scenario.layout ?? 'fast',
        scenario.wait,
      );
    const inputBridge = await bridge(
      manifest,
      path.dirname(file),
      fresh,
      scenario.cache,
    );
    try {
      const result = await playback(manifest, inputBridge, scenario.id);
      const measurement = await analyse(result.output, scenario.start, result);
      receipts.push({
        phase: scenario.id,
        ...measurement,
        ...inputBridge.stats(),
        elapsedMs: result.elapsedMs,
      });
      continuity(measurement, scenario.start);
      if (scenario.cache) {
        expect(measurement.firstFrameMs).toBeLessThan(8000);
        expect(measurement.firstByteMs).toBeLessThan(8000);
        expect(result.startedAt + measurement.firstFrameMs).toBeLessThan(
          inputBridge.stats().freshReadyAt,
        );
        expect(result.startedAt + measurement.firstByteMs).toBeLessThan(
          inputBridge.stats().freshReadyAt,
        );
        for (const count of Object.values(inputBridge.stats().counts)) {
          expect(count.cached).toBeGreaterThan(0);
          expect(count.fresh).toBeGreaterThan(0);
        }
        const control = controls.get(scenario.start);
        if (!control) throw Error('Missing matched control');
        expect(measurement.frameHash).toBe(control.frameHash);
        expect(measurement.audioHash).toBe(control.audioHash);
        expect(measurement.maxGapMs - control.maxGapMs).toBeLessThanOrEqual(
          250,
        );
        if (!scenario.layout)
          cachedRuns.set(scenario.start, [
            ...(cachedRuns.get(scenario.start) ?? []),
            measurement,
          ]);
      } else if (scenario.wait)
        delayedControls.set(scenario.start, measurement);
      else controls.set(scenario.start, measurement);
    } catch (error) {
      positiveFailed = true;
      receipts.push({
        phase: scenario.id,
        error: safeError(error),
        ...inputBridge.stats(),
      });
      throw error;
    } finally {
      receipts.push({
        phase: `${scenario.id}-cleanup`,
        ...(await inputBridge.close()),
      });
      await saveReceipt();
    }
  }, 90000);

test('synthetic timing decision and persistent-cache integrity faults', async (context) => {
  if (positiveFailed) {
    context.skip();
    return;
  }
  const runs = cachedRuns
      .get(0)
      ?.map((run) => run.firstFrameMs)
      .sort((a, b) => a - b),
    control = controls.get(0),
    delayed = delayedControls.get(0);
  if (!runs || !control || !delayed || runs.length !== 3)
    throw Error('Missing timing evidence');
  const median = runs[1];
  if (median === undefined) throw Error('No median');
  expect(median).toBeLessThanOrEqual(control.firstFrameMs + 1000);
  expect(delayed.firstFrameMs - median).toBeGreaterThanOrEqual(4000);
  const file = manifests.get('fast:0');
  if (!file) throw Error('No manifest');
  const manifest = await loadManifest(file),
    first = manifest.inputs[0]?.cells[0];
  if (!first) throw Error('No cell');
  const blob = path.join(path.dirname(file), first.file),
    original = await fs.readFile(blob);
  try {
    await fs.writeFile(blob, original.subarray(1));
    await expect(loadManifest(file)).rejects.toThrow('CORRUPT_CACHE');
  } finally {
    await fs.writeFile(blob, original);
  }
  for (const fault of [
    'changed',
    'changed-audio',
    'range',
    'short',
    'ignore',
  ] as const) {
    const fresh = await source('synthetic', 'fast', 0, fault),
      inputBridge = await bridge(manifest, path.dirname(file), fresh, true);
    try {
      await expect(inputBridge.compatible).rejects.toThrow();
      for (const count of Object.values(inputBridge.stats().counts))
        expect(count.fresh).toBe(0);
      receipts.push({ phase: `reject-${fault}`, ...inputBridge.stats() });
    } finally {
      await inputBridge.close();
    }
  }
  receipts.push({
    phase: 'timing-decision',
    cachedStartsMs: runs,
    immediateMs: control.firstFrameMs,
    delayedMs: delayed.firstFrameMs,
    cacheMedianMs: median,
  });
  rejectionGatesPassed = true;
  await saveReceipt();
}, 90000);

for (const stage of ['waiting', 'miss', 'exhausted'] as const)
  test(`synthetic ${stage} never leaves background work`, async (context) => {
    if (positiveFailed || !rejectionGatesPassed) {
      context.skip();
      return;
    }
    const file = manifests.get('fast:0');
    if (!file) throw Error('No cache');
    const manifest = await loadManifest(file);
    {
      const fresh = await source(
          'synthetic',
          'fast',
          stage === 'miss' ? 0 : 45000,
        ),
        inputBridge = await bridge(manifest, path.dirname(file), fresh, true);
      const cancellation =
        stage === 'exhausted'
          ? undefined
          : setTimeout(
              () => inputBridge.owner.abort(),
              stage === 'miss' ? 33000 : 2000,
            );
      try {
        let failure = '';
        let result: Awaited<ReturnType<typeof playback>> | undefined;
        try {
          result = await playback(manifest, inputBridge, `fault-${stage}`);
        } catch (error) {
          failure = safeError(error);
        }
        if (stage === 'exhausted' && result) {
          const measured = await analyse(result.output, 0, result);
          expect(measured.duration < 39.96 || measured.maxGapMs > 5000).toBe(
            true,
          );
          receipts.push({ phase: stage, measured });
        } else expect(failure.length).toBeGreaterThan(0);
        if (stage === 'miss')
          expect(
            Object.values(inputBridge.stats().counts).some(
              (count) => count.fresh > 0,
            ),
          ).toBe(true);
        if (stage === 'waiting')
          for (const count of Object.values(inputBridge.stats().counts))
            expect(count.fresh).toBe(0);
        const cleanupStart = performance.now(),
          cleanup = await inputBridge.close(),
          ended = bodyBytes;
        await delay(100);
        expect(bodyBytes).toBe(ended);
        expect(children.size).toBe(0);
        expect(performance.now() - cleanupStart).toBeLessThanOrEqual(5000);
        receipts.push({ phase: `fault-${stage}`, failure, cleanup });
      } finally {
        clearTimeout(cancellation);
        await inputBridge.close();
      }
    }
    completedFailureCases.add(stage);
    deterministicPassed =
      completedFailureCases.size === 3 && rejectionGatesPassed;
    await saveReceipt();
  }, 90000);

// A paced 30s decoder still reads ahead. Map actual packet offsets through the
// already captured logical object, then retain only window and complete init cells.
async function trimProviderWindow(
  manifest: Manifest,
  preparation: Awaited<ReturnType<typeof bridge>>,
  signal: AbortSignal,
) {
  for (const [index, input] of manifest.inputs.entries()) {
    const selected = preparation.inputs[index];
    if (!selected || selected.source.type !== 'http')
      throw Error('Missing prepared input');
    const authorization = selected.source.extraHeaders?.Authorization;
    if (!authorization) throw Error('Missing preparation capability');
    const packetData = await native(
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'http,tcp',
        '-rw_timeout',
        '20000000',
        '-probesize',
        '1048576',
        '-analyzeduration',
        '1000000',
        '-headers',
        `Authorization: ${authorization}\r\n`,
        '-read_intervals',
        '0%+31',
        '-show_packets',
        '-show_entries',
        'packet=pts_time,pos,size',
        '-of',
        'json',
        selected.source.path,
      ],
      { executable: ffprobe, signal },
    );
    const parsed = z
      .object({
        packets: z.array(
          z.object({
            pts_time: z.coerce.number(),
            pos: z.coerce.number(),
            size: z.coerce.number(),
          }),
        ),
      })
      .parse(JSON.parse(packetData.data.toString()));
    const needed = new Set<number>();
    let lastPayload = 0;
    for (const packet of parsed.packets)
      if (packet.pts_time < 30) {
        if (
          !Number.isSafeInteger(packet.pos) ||
          !Number.isSafeInteger(packet.size) ||
          packet.pos < 0 ||
          packet.size <= 0 ||
          packet.pos + packet.size > input.size
        )
          throw Error('Invalid provider packet bounds');
        lastPayload = Math.max(lastPayload, packet.pos + packet.size);
        for (
          let offset = Math.floor(packet.pos / cellSize) * cellSize;
          offset < packet.pos + packet.size;
          offset += cellSize
        )
          needed.add(offset);
      }
    if (!lastPayload) throw Error('No bounded provider packets');
    const relayInput = { source: selected.source, size: input.size };
    for (let position = 0; position < input.size; ) {
      const header = await rangeRead(
        relayInput,
        position,
        Math.min(position + 15, input.size - 1),
        signal,
      );
      if (header.length < 8) throw Error('Invalid provider atom header');
      const shortSize = header.readUInt32BE(0),
        type = header.toString('ascii', 4, 8);
      const length =
        shortSize === 1
          ? Number(header.readBigUInt64BE(8))
          : shortSize || input.size - position;
      const headerSize = shortSize === 1 ? 16 : 8;
      if (
        !Number.isSafeInteger(length) ||
        length < headerSize ||
        position + length > input.size
      )
        throw Error('Invalid provider atom length');
      if (
        position > lastPayload &&
        !['moov', 'sidx', 'ftyp', 'mfra'].includes(type)
      )
        break;
      const bytes = type === 'mdat' ? headerSize : length;
      if (bytes > 1024 * 1024) throw Error('Provider initialization cap');
      for (
        let offset = Math.floor(position / cellSize) * cellSize;
        offset < position + bytes;
        offset += cellSize
      )
        needed.add(offset);
      position += length;
    }
    input.cells = [...needed]
      .sort((a, b) => a - b)
      .map((offset) => {
        const cell = preparation.captured.get(`${index}-${offset}`);
        if (!cell) throw Error('Required preparation cell was not captured');
        return cell;
      });
  }
  receipts.push({
    phase: 'provider-window',
    targetSeconds: 30,
    inputs: manifest.inputs.map((input) => ({
      id: input.id,
      size: input.size,
      cachedBytes: input.cells.reduce(
        (sum, cell) => sum + cell.end - cell.start + 1,
        0,
      ),
      cells: input.cells.map((cell) => ({ start: cell.start, end: cell.end })),
    })),
  });
}

let providerManifest: Manifest | undefined;
let providerFolder = '';
for (const phase of ['prepare', 'control', 'cached'] as const)
  test(`provider explicitly opted-in ${phase}`, async (context) => {
    if (
      !deterministicPassed ||
      process.env.TUNARR_TEST_YOUTUBE_CACHE_LIVE !== '1'
    ) {
      receipts.push({
        phase: 'provider',
        outcome: 'Not run - deterministic gate or explicit live opt-in absent',
      });
      context.skip();
      return;
    }
    expect(process.env.TUNARR_TEST_YOUTUBE_CACHE_VIDEO_ID).toBe(liveId);
    if (phase === 'prepare') {
      const fresh = await source('provider'),
        folder = path.join(directory, 'provider-cache');
      await fs.mkdir(folder, { mode: 0o700 });
      let preparation: Awaited<ReturnType<typeof bridge>> | undefined;
      try {
        const resolved = await fresh.ready;
        const inputs = resolved.inputs.map((input) => {
          const probe = fresh.probes.get(input.id);
          if (!probe) throw Error('No provider probe');
          return {
            id: input.id,
            size: input.size,
            mime: input.mime,
            probe,
            cells: [],
          };
        });
        const manifest = manifestSchema.parse({
          version: 1,
          item: liveId,
          start: 0,
          durationMs: resolved.result.streamDetails.duration?.asMilliseconds(),
          inputs,
        });
        preparation = await bridge(manifest, folder, fresh, false, true);
        await playback(manifest, preparation, 'provider-prepare', 30);
        await trimProviderWindow(manifest, preparation, fresh.owner.signal);
        const file = path.join(folder, 'manifest.json');
        await fs.writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
        providerManifest = await loadManifest(file);
        providerFolder = folder;
      } catch (error) {
        receipts.push({
          phase: 'provider-prepare',
          outcome: 'Blocked',
          error: safeError(error),
          code:
            error instanceof YouTubeError ? error.code : 'HARNESS_OR_PROTOCOL',
        });
        if (!(error instanceof YouTubeError)) throw error;
        // A typed provider/tool refusal is a measured blocker, not a successful
        // playback result. Never try another video, credentials or bypass.
      } finally {
        if (preparation) {
          await preparation.close();
          const retained = new Set(
            providerManifest?.inputs.flatMap((input) =>
              input.cells.map((cell) => cell.file),
            ) ?? [],
          );
          for (const cell of preparation.captured.values())
            if (!retained.has(cell.file))
              await fs.rm(path.join(folder, cell.file), { force: true });
        } else await fresh.close();
      }
      return;
    }
    if (!providerManifest) {
      receipts.push({
        phase: `provider-${phase}`,
        outcome: 'Not run - preparation failed',
      });
      context.skip();
      return;
    }
    const manifest = providerManifest,
      folder = providerFolder,
      useCache = phase === 'cached';
    {
      const next = await source('provider'),
        inputBridge = await bridge(manifest, folder, next, useCache);
      try {
        const result = await playback(
          manifest,
          inputBridge,
          `provider-${useCache ? 'cached' : 'control'}`,
        );
        const measured = await analyse(result.output, 0, result, false);
        receipts.push({
          phase: useCache ? 'provider-cached' : 'provider-control',
          measured,
          ...inputBridge.stats(),
          representationVerdict:
            'Observed cached-span equality only; strong whole-object identity unverified through unchanged relay; at most Conditional',
        });
        for (const count of Object.values(inputBridge.stats().counts))
          if (useCache) {
            expect(count.cached).toBeGreaterThan(0);
            expect(count.fresh).toBeGreaterThan(0);
          }
        await inputBridge.compatible;
      } catch (error) {
        receipts.push({
          phase: 'provider',
          outcome: 'Blocked/No-go',
          error: safeError(error),
          ...inputBridge.stats(),
        });
        throw error;
      } finally {
        await inputBridge.close();
        await saveReceipt();
      }
    }
  }, 90000);
