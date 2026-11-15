// Isolated readiness experiment, not a production policy or network-enabled CI test.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { ClientRequest, createServer, get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type * as Timers from 'node:timers/promises';
import type { TimerOptions } from 'node:timers';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import { Container } from 'inversify';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
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
import { YouTubeAdapter } from '../external/youtube/YouTubeAdapter.ts';
import type { YouTubeResolvedMedia } from '../external/youtube/YouTubeAdapter.ts';
import { YouTubeMediaRelay } from './YouTubeMediaRelay.ts';
import { YouTubePlaybackResolver } from './YouTubePlaybackResolver.ts';
import { mediaInputs } from './MediaInputs.ts';

const local = vi.hoisted(() => ({
  base: '',
  bypassInitialWait: false,
  waits: [] as Array<{
    bypassed: boolean;
    requestedMs: number;
    elapsedMs: number;
  }>,
}));
vi.mock('../util/serverUtil.ts', () => ({ makeLocalUrl: () => local.base }));
vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof Timers>();
  return {
    ...timers,
    setTimeout: async <T = void>(
      ms?: number,
      value?: T,
      options?: TimerOptions,
    ): Promise<T> => {
      const bypassed = local.bypassInitialWait && ms === 7000;
      const start = performance.now();
      // Even the suppressed sleep is a real, abort-aware timer. No virtual live clock.
      try {
        return await timers.setTimeout<T>(bypassed ? 0 : ms, value, options);
      } finally {
        if (ms === 7000) {
          local.waits.push({
            bypassed,
            requestedMs: ms,
            elapsedMs: performance.now() - start,
          });
        }
      }
    },
  };
});
dayjs.extend(duration);
afterEach(() => {
  local.bypassInitialWait = false;
  vi.useRealTimers();
});

const GateMs = 7000;
const RangeBytes = 65536;
type SelectedInput = YouTubeResolvedMedia['inputs'][number];
type GateEvent = { inputId: string; atMs: number; ready: boolean };
type GateResult = {
  startedAtMs: number;
  outcome: 'early' | 'fallback';
  elapsedMs: number;
  events: GateEvent[];
};
const safe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"']+/g, 'URL_REDACTED')
    .replace(/Bearer\s+[^\s]+/g, 'Bearer REDACTED')
    .slice(-1024);

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('Cancelled pause'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

// This coordinator and its dependencies belong only to this local experiment.
async function readinessGate(
  inputs: readonly SelectedInput[],
  signal: AbortSignal,
  check: (input: SelectedInput, signal: AbortSignal) => Promise<boolean>,
): Promise<GateResult> {
  signal.throwIfAborted();
  if (
    !inputs.length ||
    new Set(inputs.map((input) => input.id)).size !== inputs.length
  ) {
    throw Error('Invalid captured set');
  }
  const start = performance.now();
  const owner = new AbortController();
  const abort = () => owner.abort();
  signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, GateMs);
  const ready = new Set<string>();
  const events: GateEvent[] = [];
  try {
    for (let pass = 0; pass < 14 && !owner.signal.aborted; pass++) {
      for (const input of inputs) {
        if (ready.has(input.id)) {
          continue;
        }
        signal.throwIfAborted();
        const remaining = GateMs - (performance.now() - start);
        if (remaining <= 0 || owner.signal.aborted) {
          break;
        }
        const request = new AbortController();
        const cancelRequest = () => request.abort();
        owner.signal.addEventListener('abort', cancelRequest, { once: true });
        const limit = setTimeout(cancelRequest, Math.min(1000, remaining));
        let accepted = false;
        try {
          accepted = await check(input, request.signal);
        } catch {
          /* An unavailable read is not readiness or an inferred upstream status. */
        } finally {
          clearTimeout(limit);
          owner.signal.removeEventListener('abort', cancelRequest);
        }
        signal.throwIfAborted();
        // A late successful result after cancellation/deadline cannot admit playback.
        accepted =
          accepted &&
          !request.signal.aborted &&
          !owner.signal.aborted &&
          performance.now() - start < GateMs;
        events.push({
          inputId: input.id,
          atMs: performance.now() - start,
          ready: accepted,
        });
        if (accepted) {
          ready.add(input.id);
        }
      }
      if (ready.size === inputs.length) {
        return {
          startedAtMs: start,
          outcome: 'early',
          elapsedMs: performance.now() - start,
          events,
        };
      }
      if (owner.signal.aborted) {
        break;
      }
      try {
        await pause(
          Math.min(500, Math.max(0, GateMs - (performance.now() - start))),
          owner.signal,
        );
      } catch {
        /* Distinguish the owning cancellation from the finite gate deadline below. */
      }
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (performance.now() - start > GateMs + 500) {
      throw Error('Gate cleanup exceeded handoff allowance');
    }
    return {
      startedAtMs: start,
      outcome: 'fallback',
      elapsedMs: performance.now() - start,
      events,
    };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    owner.abort();
  }
}

async function idle(relay: YouTubeMediaRelay, limitMs: number) {
  const end = performance.now() + limitMs;
  while (relay.status.requests && performance.now() < end) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  if (relay.status.requests) {
    throw Error('Relay cleanup did not settle');
  }
}

async function rangeHint(
  relay: YouTubeMediaRelay,
  input: SelectedInput,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const lease = relay.register({ ...input, signal, baseUrl: local.base });
  try {
    return await new Promise<boolean>((resolve) => {
      let accepted = false;
      const request = get(
        lease.source.path,
        {
          signal,
          headers: { ...lease.source.extraHeaders, Range: 'bytes=0-65535' },
        },
        (response) => {
          const match = /^bytes 0-(\d+)\/(\d+)$/.exec(
            String(response.headers['content-range']),
          );
          const end = match ? Number(match[1]) : -1;
          const total = match ? Number(match[2]) : -1;
          const coherent =
            response.statusCode === 206 &&
            Number.isSafeInteger(total) &&
            total > 0 &&
            end === Math.min(RangeBytes, total) - 1 &&
            Number(response.headers['content-length']) === end + 1;
          let received = 0;
          response.on('data', (data: Buffer) => {
            received += data.length;
            if (received > RangeBytes) {
              response.destroy();
            }
          });
          response.once('end', () => {
            accepted = coherent && response.complete && received === end + 1;
          });
          response.once('error', () => {
            accepted = false;
          });
        },
      );
      request.once('error', () => {
        accepted = false;
      });
      // Wait for socket closure, including aborted/truncated responses, before releasing the lease.
      request.once('close', () => resolve(accepted));
    });
  } finally {
    lease.release();
    await idle(relay, 500);
  }
}

const fixtureInputs: SelectedInput[] = ['video', 'audio'].map((id) => ({
  id,
  url: 'https://a.googlevideo.com/videoplayback',
  headers: {},
}));

test('ready inputs continue early; a lagging input alone is retried', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const calls = new Map<string, number>();
  const result = readinessGate(
    fixtureInputs,
    new AbortController().signal,
    (input) => {
      const count = (calls.get(input.id) ?? 0) + 1;
      calls.set(input.id, count);
      return Promise.resolve(input.id === 'video' || count === 2);
    },
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toMatchObject({ outcome: 'early', elapsedMs: 500 });
  expect([...calls]).toEqual([
    ['video', 1],
    ['audio', 2],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test('persistent unavailable reads hand the same set off once at seven seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const checks: string[] = [];
  const result = readinessGate(
    fixtureInputs,
    new AbortController().signal,
    (input) => {
      checks.push(input.id);
      return Promise.resolve(false);
    },
  );
  await vi.advanceTimersByTimeAsync(7000);
  expect(await result).toMatchObject({ outcome: 'fallback', elapsedMs: 7000 });
  expect(checks.filter((id) => id === 'video')).toHaveLength(14);
  expect(checks.filter((id) => id === 'audio')).toHaveLength(14);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['backoff', 'inflight', 'expiry'])(
  'owner cancellation/slot expiry stops %s work',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const owner = new AbortController();
    let active = 0;
    const result = readinessGate(
      fixtureInputs,
      owner.signal,
      async (_input, signal) => {
        if (mode === 'backoff') {
          return false;
        }
        active++;
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return true;
        } finally {
          active--;
        }
      },
    );
    const rejected = expect(result).rejects.toThrow();
    if (mode === 'expiry') {
      setTimeout(() => owner.abort(), 250);
    } else {
      await vi.advanceTimersByTimeAsync(1);
      owner.abort();
    }
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('a stalled read has a one-second limit and cannot become late readiness', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let active = 0;
  const result = readinessGate(
    fixtureInputs,
    new AbortController().signal,
    async (_input, signal) => {
      active++;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            active--;
            resolve();
          },
          { once: true },
        ),
      );
      return true;
    },
  );
  await vi.advanceTimersByTimeAsync(7000);
  const measured = await result;
  expect(measured.outcome).toBe('fallback');
  expect(measured.events.every((event) => !event.ready)).toBe(true);
  expect(active).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  'valid-short',
  'ignored-range',
  'wrong-range',
  'truncated',
  'oversized',
  'unavailable',
])('real loopback range admission: %s', async (mode) => {
  const body = Buffer.alloc(mode === 'oversized' ? RangeBytes + 1 : 32);
  const relay = new YouTubeMediaRelay(() =>
    Promise.resolve({
      statusCode:
        mode === 'unavailable' ? 403 : mode === 'ignored-range' ? 200 : 206,
      headers: {
        'content-range':
          mode === 'wrong-range'
            ? 'bytes 1-32/33'
            : mode === 'truncated'
              ? 'bytes 0-63/64'
              : `bytes 0-${body.length - 1}/${body.length}`,
        'content-length': String(mode === 'truncated' ? 64 : body.length),
      },
      body: Readable.from([body]),
    }),
  );
  const server = createServer((req, res) => {
    void relay.handle(req, res);
  });
  const owner = new AbortController();
  const stop = setTimeout(() => owner.abort(), 3000);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw Error('Missing port');
    }
    local.base = `http://127.0.0.1:${address.port}/`;
    const input = fixtureInputs[0];
    if (!input) {
      throw Error('Missing fixture input');
    }
    expect(await rangeHint(relay, input, owner.signal)).toBe(
      mode === 'valid-short',
    );
  } finally {
    clearTimeout(stop);
    owner.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(relay.status).toEqual({ inputs: 0, requests: 0 });
  }
});

test('a successful availability hint does not swallow downstream probe failure', async () => {
  const relay = new YouTubeMediaRelay();
  const owner = new AbortController();
  const captured = { durationSeconds: 10, inputs: fixtureInputs };
  const resolve = vi
    .fn<YouTubeAdapter['resolve']>()
    .mockResolvedValue(captured);
  const probe = vi
    .fn<YouTubeAdapter['probe']>()
    .mockRejectedValue(new Error('Invalid media'));
  const settings = {
    ffmpegSettings: () => ({ ffprobeExecutablePath: 'unused' }),
  } as ISettingsDB;
  try {
    const gate = await readinessGate(fixtureInputs, owner.signal, () =>
      Promise.resolve(true),
    );
    expect(gate.outcome).toBe('early');
    const resolver = new YouTubePlaybackResolver(
      { resolve, probe },
      relay,
      settings,
    );
    await expect(
      resolver.resolve('aqz-KE-bpKQ', owner.signal, 720),
    ).rejects.toThrow('Invalid media');
    expect(resolve).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(relay.status).toEqual({ inputs: 0, requests: 0 });
  } finally {
    owner.abort();
  }
});

const profile: TranscodeConfigOrm = {
  uuid: 'startup-diagnostic',
  name: 'Startup diagnostic',
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

test.skipIf(process.env.TUNARR_TEST_YOUTUBE_STARTUP_LIVE !== '1')(
  'bounded fresh baseline/candidate campaign',
  async () => {
    process.umask(0o077);
    const root = path.resolve(process.cwd(), '../config/youtube-cache-spike');
    await fs.mkdir(root, { recursive: true });
    const folder = await fs.mkdtemp(path.join(root, 'readiness-'));
    const rows: Record<string, unknown>[] = [],
      network: Record<string, unknown>[] = [];
    const results: Array<{
      name: string;
      arm: string;
      pair?: number;
      offset: number;
      startedAtMs: number;
      inputIds?: string[];
      firstFrameMs?: number;
      failure?: string;
    }> = [];
    const children = new Set<number>();
    const campaign = new AbortController();
    const watchdog = setTimeout(() => campaign.abort(), 12 * 60000);
    const priorBytes = Number(
      process.env.TUNARR_TEST_YOUTUBE_STARTUP_PRIOR_BYTES ?? '134956314',
    );
    const byteCap = Math.min(64 * 1048576, 256 * 1048576 - priorBytes);
    if (
      !Number.isSafeInteger(priorBytes) ||
      priorBytes < 134956314 ||
      byteCap <= 0
    ) {
      clearTimeout(watchdog);
      throw Error('Invalid remaining campaign budget');
    }
    let forwardedBytes = 0,
      phase = 'setup';
    const ffmpeg = '/usr/local/bin/ffmpeg',
      ffprobe = '/usr/local/bin/ffprobe';
    function observe(message: unknown) {
      if (!message || typeof message !== 'object') {
        return;
      }
      const request: unknown = Reflect.get(message, 'request');
      if (!(request instanceof ClientRequest)) {
        return;
      }
      const host = request.getHeader('host');
      if (
        typeof host !== 'string' ||
        !/(^|\.)googlevideo\.com(?::443)?$/.test(host)
      ) {
        return;
      }
      const start = performance.now();
      const row: Record<string, unknown> = {
        phase,
        method: request.method,
        range: request.getHeader('range') ?? null,
        startedAtMs: start,
      };
      network.push(row);
      request.once('response', (response) => {
        row.status = response.statusCode;
        row.headersMs = performance.now() - start;
        response.once('close', () => {
          row.closedAtMs = performance.now();
          row.complete = response.complete;
        });
      });
      request.once('error', () => {
        row.error = 'REQUEST_ERROR';
      });
    }
    const diagnostic = channel('http.client.request.created');
    diagnostic.subscribe(observe);
    const relay = new YouTubeMediaRelay();
    const server = createServer((req, res) => {
      const write = res.write.bind(res);
      res.write = (
        chunk: unknown,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
          throw Error('Nonbinary relay chunk');
        }
        const length =
          typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        forwardedBytes += length;
        if (forwardedBytes > byteCap) {
          campaign.abort();
          res.destroy();
          return false;
        }
        return typeof encodingOrCallback === 'function'
          ? write(chunk, encodingOrCallback)
          : write(chunk, encodingOrCallback ?? 'utf8', callback);
      };
      void relay.handle(req, res);
    });
    async function timed<T>(
      stage: string,
      action: () => Promise<T>,
    ): Promise<T> {
      const start = performance.now();
      try {
        return await action();
      } finally {
        rows.push({
          stage,
          phase,
          startedAtMs: start,
          elapsedMs: performance.now() - start,
        });
      }
    }
    async function native(args: string[], signal: AbortSignal) {
      signal.throwIfAborted();
      const start = performance.now();
      const child = spawn(
        ffmpeg,
        ['-progress', 'pipe:3', '-stats_period', '0.1', ...args],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
      );
      const pid = child.pid;
      if (!pid || !child.stdout || !child.stderr) {
        throw Error('Missing child');
      }
      children.add(pid);
      const kill = (kind: NodeJS.Signals) => {
        try {
          process.kill(-pid, kind);
        } catch {
          /* already closed */
        }
      };
      const stop = () => kill('SIGTERM');
      let force: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        stop();
        force ??= setTimeout(() => kill('SIGKILL'), 4000);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      const deadline = setTimeout(abort, 75000);
      let firstByteMs: number | undefined,
        firstFrameMs: number | undefined,
        bytes = 0,
        progress = '',
        stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        firstByteMs ??= performance.now() - start;
        bytes += data.length;
        if (bytes > 4 * 1048576) {
          abort();
        }
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2048);
      });
      child.stdio[3]?.on('data', (data: Buffer) => {
        progress += data.toString();
        let end: number;
        while ((end = progress.indexOf('\n')) >= 0) {
          const line = progress.slice(0, end);
          progress = progress.slice(end + 1);
          if (line.startsWith('frame=') && Number(line.slice(6)) > 0) {
            firstFrameMs ??= performance.now() - start;
          }
        }
        if (progress.length > 4096) {
          abort();
        }
      });
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('close', resolve);
          child.once('error', reject);
        });
        signal.throwIfAborted();
        if (
          code !== 0 ||
          firstFrameMs === undefined ||
          firstByteMs === undefined ||
          bytes > 4 * 1048576
        ) {
          throw Error(`Native failure ${String(code)}: ${safe(stderr)}`);
        }
        return {
          firstByteMs,
          firstFrameMs,
          elapsedMs: performance.now() - start,
          outputBytes: bytes,
        };
      } finally {
        clearTimeout(deadline);
        clearTimeout(force);
        signal.removeEventListener('abort', abort);
        children.delete(pid);
      }
    }
    let fatal: string | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw Error('Missing port');
      }
      local.base = `http://127.0.0.1:${address.port}/`;
      const parsed = FfmpegSettingsSchema.parse({
        ffmpegExecutablePath: ffmpeg,
        ffprobeExecutablePath: ffprobe,
        logLevel: 'error',
        enableLogging: false,
        enableFileLogging: false,
      });
      const settings = {
        ffmpegSettings: () => parsed,
        systemSettings: () => ({ logging: { logsDirectory: folder } }),
      } as unknown as ISettingsDB;
      const info = new FfmpegInfo(ffmpeg, ffprobe);
      await info.seed();
      const flags = { get: () => false } as unknown as FeatureFlagService;
      const container = new Container();
      container.bind(KEYS.SettingsDB).toConstantValue(settings);
      container.bind(FfmpegInfo).toConstantValue(info);
      container.bind(FeatureFlagService).toConstantValue(flags);
      container.load(FfmpegPipelineBuilderModule);
      const cases = [
        { name: 'pair1-baseline', arm: 'baseline', pair: 1, offset: 77.3 },
        { name: 'pair1-candidate', arm: 'candidate', pair: 1, offset: 77.3 },
        { name: 'pair2-candidate', arm: 'candidate', pair: 2, offset: 77.3 },
        { name: 'pair2-baseline', arm: 'baseline', pair: 2, offset: 77.3 },
        { name: 'pair3-baseline', arm: 'baseline', pair: 3, offset: 77.3 },
        { name: 'pair3-candidate', arm: 'candidate', pair: 3, offset: 77.3 },
        { name: 'opening-candidate', arm: 'candidate', offset: 0 },
      ];
      for (const item of cases) {
        campaign.signal.throwIfAborted();
        phase = item.name;
        local.waits = [];
        const owner = new AbortController();
        const abort = () => owner.abort();
        campaign.signal.addEventListener('abort', abort, { once: true });
        const limit = setTimeout(abort, 90000);
        const started = performance.now();
        const result: (typeof results)[number] = {
          ...item,
          startedAtMs: started,
        };
        let captures = 0;
        try {
          const adapter = new YouTubeAdapter();
          const internals = adapter as unknown as {
            extract: (id: string, signal: AbortSignal) => Promise<unknown>;
            version: (signal: AbortSignal) => Promise<string>;
            runtime: (signal: AbortSignal) => Promise<string>;
          };
          const extract = internals.extract.bind(adapter),
            version = internals.version.bind(adapter),
            runtime = internals.runtime.bind(adapter);
          internals.extract = (id, signal) =>
            timed('extract including tool checks', () => extract(id, signal));
          internals.version = (signal) =>
            timed('extractor version', () => version(signal));
          internals.runtime = (signal) =>
            timed('runtime version', () => runtime(signal));
          let prepared: YouTubeResolvedMedia | undefined;
          if (item.arm === 'candidate') {
            local.bypassInitialWait = true;
            try {
              captures++;
              prepared = await timed(
                'fresh initial capture, intended sleep omitted',
                () => adapter.resolve('aqz-KE-bpKQ', 720, owner.signal),
              );
            } finally {
              local.bypassInitialWait = false;
            }
            expect(local.waits).toHaveLength(1);
            expect(local.waits[0]?.bypassed).toBe(true);
            const previous = phase;
            phase += ':gate';
            const gate = await readinessGate(
              prepared.inputs,
              owner.signal,
              (input, signal) => rangeHint(relay, input, signal),
            );
            rows.push({ stage: 'readiness gate', phase, ...gate });
            phase = previous;
            expect(relay.status).toEqual({ inputs: 0, requests: 0 });
          }
          let servedPrepared = false,
            probes = 0;
          const resolver = new YouTubePlaybackResolver(
            {
              resolve: async (id, height, signal) => {
                if (prepared && !servedPrepared) {
                  signal.throwIfAborted();
                  servedPrepared = true;
                  return prepared;
                }
                captures++;
                if (captures > 2) {
                  throw Error('Source capture cap');
                }
                return timed('normal adapter resolve including real wait', () =>
                  adapter.resolve(id, height, signal),
                );
              },
              probe: (...args) => {
                const previous = phase;
                phase += `:probe-${++probes}`;
                return timed('input probe', () =>
                  adapter.probe(...args),
                ).finally(() => {
                  phase = previous;
                });
              },
            },
            relay,
            settings,
          );
          const resolved = await timed('resolver', () =>
            resolver.resolve('aqz-KE-bpKQ', owner.signal, 720),
          );
          result.inputIds = mediaInputs(resolved).map((input) => input.id);
          rows.push({
            stage: 'chosen input IDs',
            phase,
            ids: result.inputIds,
            captures,
          });
          const audio = resolved.streamDetails.audioDetails?.[0];
          if (!audio) {
            throw Error('Missing audio');
          }
          const selector = {
            selectAudioAndSubtitleStreams: () =>
              Promise.resolve({ audioStream: audio, subtitleStream: null }),
          } as unknown as StreamSelector;
          const diagnosticChannel = {
            uuid: 'startup-diagnostic',
            name: 'Startup diagnostic',
            number: 999,
            streamMode: 'mpegts',
            subtitlesEnabled: false,
            offline: { mode: 'pic' },
          } as ChannelOrm;
          const factory = new FfmpegStreamFactory(
            info,
            settings,
            container.get<PipelineBuilderFactory>(KEYS.PipelineBuilderFactory),
            flags,
            selector,
            profile,
            diagnosticChannel,
          );
          const factoryStart = performance.now();
          const produced: unknown = await factory.createStreamSession({
            stream: {
              inputs: mediaInputs(resolved),
              details: resolved.streamDetails,
            },
            options: {
              startTime: dayjs.duration(item.offset, 'seconds'),
              duration: dayjs.duration(5, 'seconds'),
              outputFormat: MpegTsOutputFormat,
              realtime: true,
              streamMode: 'mpegts',
            },
            lineupItem: {
              type: 'program',
              program: {},
              programBeginMs: Date.now(),
              startOffset: item.offset * 1000,
              duration: (item.offset + 5) * 1000,
              streamDuration: 5000,
              infiniteLoop: false,
            } as ContentBackedStreamLineupItem,
          });
          rows.push({
            stage: 'factory',
            phase,
            startedAtMs: factoryStart,
            elapsedMs: performance.now() - factoryStart,
          });
          const session = z
            .object({
              session: z.object({
                process: z.object({ args: z.array(z.string()) }),
              }),
            })
            .parse(produced);
          const args = session.session.process.args;
          rows.push({
            stage: 'seek arguments',
            phase,
            values: args.flatMap((arg, i) =>
              arg === '-ss' ? [args[i + 1]] : [],
            ),
          });
          const beforeNative = performance.now();
          phase = `${item.name}:native`;
          const output = await native(args, owner.signal);
          result.firstFrameMs = beforeNative - started + output.firstFrameMs;
          rows.push({
            stage: 'native',
            phase,
            startedAtMs: beforeNative,
            ...output,
            requestToFirstByteMs: beforeNative - started + output.firstByteMs,
            requestToFirstFrameMs: result.firstFrameMs,
          });
          expect(local.waits.filter((wait) => wait.bypassed)).toHaveLength(
            item.arm === 'candidate' ? 1 : 0,
          );
          expect(
            local.waits
              .filter((wait) => !wait.bypassed)
              .every((wait) => wait.elapsedMs >= GateMs - 1),
          ).toBe(true);
          if (item.arm === 'baseline') {
            expect(local.waits.length).toBeGreaterThanOrEqual(1);
          }
        } catch (error) {
          result.failure = safe(error);
        } finally {
          local.bypassInitialWait = false;
          clearTimeout(limit);
          owner.abort();
          campaign.signal.removeEventListener('abort', abort);
          await idle(relay, 5000);
          rows.push({
            stage: 'case cleanup',
            phase: item.name,
            captures,
            waits: [...local.waits],
            relayStatus: relay.status,
            children: [...children],
          });
          expect(relay.status).toEqual({ inputs: 0, requests: 0 });
          expect(children.size).toBe(0);
          results.push(result);
        }
      }
    } catch (error) {
      fatal = safe(error);
      throw error;
    } finally {
      clearTimeout(watchdog);
      campaign.abort();
      local.bypassInitialWait = false;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      diagnostic.unsubscribe(observe);
      const differences: number[] = [];
      for (const pair of [1, 2, 3]) {
        const baseline = results.find(
          (result) => result.pair === pair && result.arm === 'baseline',
        );
        const candidate = results.find(
          (result) => result.pair === pair && result.arm === 'candidate',
        );
        if (
          baseline?.firstFrameMs !== undefined &&
          candidate?.firstFrameMs !== undefined &&
          !baseline.failure &&
          !candidate.failure &&
          baseline.inputIds?.length &&
          JSON.stringify(baseline.inputIds) ===
            JSON.stringify(candidate.inputIds)
        ) {
          differences.push(baseline.firstFrameMs - candidate.firstFrameMs);
        }
      }
      const ordered = [...differences].sort((a, b) => a - b);
      const medianImprovementMs = ordered.length === 3 ? ordered[1] : undefined;
      const pairedPlaybackFailure = results.some(
        (candidate) =>
          candidate.arm === 'candidate' &&
          candidate.failure &&
          results.some(
            (baseline) =>
              baseline.arm === 'baseline' &&
              baseline.pair === candidate.pair &&
              !baseline.failure,
          ),
      );
      const verdict = pairedPlaybackFailure
        ? 'Not promising as tested'
        : fatal ||
            differences.length !== 3 ||
            results.some((result) => result.failure)
          ? 'Inconclusive/Blocked'
          : medianImprovementMs !== undefined && medianImprovementMs >= 3000
            ? 'Promising'
            : 'Not promising as tested';
      const source = await fs.readFile(
        path.resolve('src/stream/YouTubeStartupReadiness.local.test.ts'),
      );
      await fs.writeFile(
        path.join(folder, 'receipt.json'),
        JSON.stringify(
          {
            sourceSha256: createHash('sha256').update(source).digest('hex'),
            results,
            rows,
            network,
            differences,
            medianImprovementMs,
            verdict,
            forwardedBytes,
            priorBytes,
            totalIncludingPrior: priorBytes + forwardedBytes,
            byteCap,
            fatal,
            relayStatus: relay.status,
            children: [...children],
            scope:
              'One source,720 ceiling,160x90 software MPEGTS,five-second outputs. First frame is FFmpeg progress,not rendered/browser/HLS/HQ or reliability acceptance. No media cache,stored media,production changes or diagnostic-driven success. Lookup child compute/network attribution remains mixed. Body counter excludes extractor/TLS traffic.',
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(
        `Readiness receipt: ${folder}/receipt.json; verdict=${verdict}`,
      );
      expect(children.size).toBe(0);
      expect(relay.status).toEqual({ inputs: 0, requests: 0 });
    }
  },
  12 * 60000 + 10000,
);
