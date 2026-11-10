import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type {
  YouTubeAdapter,
  YouTubeResolvedMedia,
} from '../external/youtube/YouTubeAdapter.ts';
import { FfprobeMediaInfoSchema } from '../types/ffmpeg.ts';
import { YouTubeMediaRelay } from './YouTubeMediaRelay.ts';
import { YouTubePlaybackResolver } from './YouTubePlaybackResolver.ts';

vi.mock('../util/serverUtil.ts', () => ({
  makeLocalUrl: () => 'http://localhost:8000/',
}));

const owners: AbortController[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.abort();
  vi.useRealTimers();
});
const media = (suffix = 'old'): YouTubeResolvedMedia => ({
  durationSeconds: 10,
  inputs: [
    {
      id: 'video',
      url: `https://a.googlevideo.com/videoplayback?sig=${suffix}-video`,
      headers: { 'User-Agent': 'fixture' },
    },
    {
      id: 'audio',
      url: `https://a.googlevideo.com/videoplayback?sig=${suffix}-audio`,
      headers: { 'User-Agent': 'fixture' },
    },
  ],
});
const video = FfprobeMediaInfoSchema.parse({
  streams: [
    {
      index: 3,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      coded_width: 1280,
      coded_height: 720,
      r_frame_rate: '30/1',
    },
  ],
  format: {
    nb_streams: 1,
    format_name: 'mov',
    duration: 10,
    size: 1000,
    bit_rate: 800,
  },
});
const audio = FfprobeMediaInfoSchema.parse({
  streams: [
    {
      index: 7,
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
      disposition: { default: 1 },
    },
  ],
  format: {
    nb_streams: 1,
    format_name: 'mov',
    duration: 10,
    size: 1000,
    bit_rate: 800,
  },
});
function fixture() {
  const owner = new AbortController();
  owners.push(owner);
  const adapter = {
    resolve: vi.fn<YouTubeAdapter['resolve']>().mockResolvedValue(media()),
    probe: vi
      .fn<YouTubeAdapter['probe']>()
      .mockResolvedValueOnce(video)
      .mockResolvedValueOnce(audio),
  };
  const relay = new YouTubeMediaRelay();
  const register = vi.spyOn(relay, 'register');
  const settings = {
    ffmpegSettings: () => ({ ffprobeExecutablePath: 'fixture-ffprobe' }),
  } as ISettingsDB;
  return {
    owner,
    adapter,
    relay,
    register,
    resolver: new YouTubePlaybackResolver(adapter, relay, settings),
  };
}

describe('owning YouTube playback attempts', () => {
  test('binds real probe indices to stable relay inputs and revokes them with the owner', async () => {
    const f = fixture();
    const result = await f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720);
    expect(f.adapter.resolve).toHaveBeenCalledWith(
      'aqz-KE-bpKQ',
      720,
      expect.any(AbortSignal),
    );
    expect(result.inputs.map((input) => input.id)).toEqual(['video', 'audio']);
    expect(result.streamDetails.videoDetails?.[0]).toMatchObject({
      inputId: 'video',
      streamIndex: 3,
      width: 1280,
      height: 720,
    });
    expect(result.streamDetails.audioDetails?.[0]).toMatchObject({
      inputId: 'audio',
      index: 7,
      channels: 2,
    });
    expect(result.streamDetails.duration?.asMilliseconds()).toBe(10000);
    for (const [source, executable, signal] of f.adapter.probe.mock.calls) {
      expect(source.path).toMatch(
        /^http:\/\/127\.0\.0\.1:8000\/api\/youtube\/media\//,
      );
      expect(source.extraHeaders.Authorization).toMatch(/^Bearer /);
      expect(executable).toBe('fixture-ffprobe');
      expect(signal.aborted).toBe(false);
    }
    expect(f.relay.status).toEqual({ inputs: 2, requests: 0 });
    f.owner.abort();
    expect(f.relay.status).toEqual({ inputs: 0, requests: 0 });
  });

  test('stops before late registration after cancellation during extraction', async () => {
    const f = fixture();
    let complete: ((value: YouTubeResolvedMedia) => void) | undefined;
    f.adapter.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const operation = f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720);
    f.owner.abort();
    expect(complete).toBeDefined();
    complete?.(media());
    await expect(operation).rejects.toThrow();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.adapter.probe).not.toHaveBeenCalled();
    expect(f.relay.status).toEqual({ inputs: 0, requests: 0 });
  });

  test('does not begin an already expired slot and cleans all inputs on probe failure', async () => {
    const f = fixture();
    await expect(
      f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720, Date.now() - 1),
    ).rejects.toThrow();
    expect(f.adapter.resolve).not.toHaveBeenCalled();
    f.adapter.probe.mockReset().mockRejectedValue(new Error('Probe failed'));
    await expect(
      f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720),
    ).rejects.toThrow('Probe failed');
    expect(f.relay.status).toEqual({ inputs: 0, requests: 0 });
  });

  test('renews a captured split set once for concurrent failures, without replacing its capabilities', async () => {
    const f = fixture();
    f.adapter.resolve
      .mockResolvedValueOnce(media())
      .mockResolvedValueOnce(media('fresh'));
    const result = await f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720);
    const capabilities = result.inputs.map((input) => ({
      id: input.id,
      path: input.source.path,
    }));
    const refresh = f.register.mock.calls[0]?.[0].refresh;
    expect(refresh).toBeTypeOf('function');
    expect(await Promise.all([refresh?.(0, true), refresh?.(0, true)])).toEqual(
      [true, true],
    );
    expect(f.adapter.resolve).toHaveBeenCalledTimes(2);
    expect(f.register).toHaveBeenCalledTimes(2);
    expect(
      result.inputs.map((input) => ({ id: input.id, path: input.source.path })),
    ).toEqual(capabilities);
    // A concurrent old-generation reader is not a second renewal.
    expect(await refresh?.(0, true)).toBe(true);
    expect(f.adapter.resolve).toHaveBeenCalledTimes(2);
    // A fresh-generation failure exhausts this attempt and drops both leases.
    expect(await refresh?.(1, true)).toBe(false);
    expect(f.adapter.resolve).toHaveBeenCalledTimes(2);
    expect(f.relay.status).toEqual({ inputs: 0, requests: 0 });
  });

  test.each([
    'changed duration',
    'changed input ID',
    'duplicate input ID',
    'unsafe refreshed URL',
    'terminal response',
  ] as const)('fails closed on %s', async (kind) => {
    const f = fixture();
    const fresh = media('fresh');
    const audioInput = fresh.inputs.find((input) => input.id === 'audio');
    if (!audioInput) throw new Error('Missing audio fixture');
    if (kind === 'changed duration') fresh.durationSeconds = 11;
    if (kind === 'changed input ID') audioInput.id = 'different';
    if (kind === 'duplicate input ID') audioInput.id = 'video';
    if (kind === 'unsafe refreshed URL')
      audioInput.url = 'https://127.0.0.1/private';
    f.adapter.resolve
      .mockResolvedValueOnce(media())
      .mockResolvedValueOnce(fresh);
    await f.resolver.resolve('aqz-KE-bpKQ', f.owner.signal, 720);
    const refresh = f.register.mock.calls[0]?.[0].refresh;
    expect(await refresh?.(0, kind !== 'terminal response')).toBe(false);
    expect(f.adapter.resolve).toHaveBeenCalledTimes(
      kind === 'terminal response' ? 1 : 2,
    );
    expect(f.relay.status).toEqual({ inputs: 0, requests: 0 });
  });
});
