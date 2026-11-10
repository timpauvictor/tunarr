import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  normalizeYouTubeVideoUrl,
  runYouTubeProcess,
  YouTubeAdapter,
} from './YouTubeAdapter.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const VideoId = 'aqz-KE-bpKQ';
const CanonicalUrl = `https://www.youtube.com/watch?v=${VideoId}`;
const MediaUrl =
  'https://rr1.googlevideo.com/videoplayback?signature=private-fixture';

class FixtureChild extends EventEmitter {
  readonly pid = 123456789;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  close(code = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  output(value: unknown): void {
    this.stdout.write(
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    this.close();
  }
}

function combined(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format_id: '18',
    url: MediaUrl,
    protocol: 'https',
    vcodec: 'avc1.42001E',
    acodec: 'mp4a.40.2',
    height: 360,
    dynamic_range: 'SDR',
    ...overrides,
  };
}

function video(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: VideoId,
    title: 'Finite fixture',
    duration: 12.5,
    description: 'Description',
    thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    channel_id: 'UC-fixture',
    channel: 'Fixture creator',
    upload_date: '20261026',
    tags: ['one', 'two'],
    availability: 'public',
    live_status: 'not_live',
    formats: [combined()],
    ...overrides,
  };
}

function useFixtureProcess(child: FixtureChild): void {
  vi.mocked(spawn).mockImplementation((executable) => {
    if (executable.endsWith('taskkill.exe')) {
      const killer = new FixtureChild();
      queueMicrotask(() => killer.close());
      return killer as unknown as ReturnType<typeof spawn>;
    }
    return child as unknown as ReturnType<typeof spawn>;
  });
}

type SpawnFixture = (
  child: FixtureChild,
  args: readonly string[],
  executable: string,
) => void;

function subprocesses(extraction: SpawnFixture): FixtureChild[] {
  const children: FixtureChild[] = [];
  vi.mocked(spawn).mockImplementation((executable, args) => {
    const child = new FixtureChild();
    children.push(child);
    const argv = Array.isArray(args) ? args : [];
    queueMicrotask(() => {
      if (argv.includes('--dump-single-json')) {
        extraction(child, argv, executable);
      } else if (executable === 'fixture-node') {
        child.output('v22.16.0\n');
      } else {
        child.output('2026.10.26\n');
      }
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  return children;
}

beforeEach(() => {
  vi.stubEnv('TUNARR_YTDLP_PATH', 'fixture-ytdlp');
  vi.stubEnv('TUNARR_YOUTUBE_JS_RUNTIME_PATH', 'fixture-node');
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('YouTube URL admission', () => {
  test.each([
    CanonicalUrl,
    `https://youtu.be/${VideoId}?t=2`,
    `https://www.youtube.com/shorts/${VideoId}`,
    `https://m.youtube.com/watch?v=${VideoId}&t=2`,
  ])('normalizes one finite-video identity: %s', (url) => {
    expect(normalizeYouTubeVideoUrl(url)).toEqual({
      videoId: VideoId,
      canonicalUrl: CanonicalUrl,
    });
  });

  test.each([
    'http://www.youtube.com/watch?v=aqz-KE-bpKQ',
    'https://user:pass@www.youtube.com/watch?v=aqz-KE-bpKQ',
    'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
    'https://127.0.0.1/watch?v=aqz-KE-bpKQ',
    'file:///etc/passwd',
    'aqz-KE-bpKQ',
    'https://www.youtube.com/watch?v=bad',
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ&v=aqz-KE-bpKQ',
    'https://youtu.be/aqz-KE-bpKQ/extra',
    'https://www.youtube.com/embed/aqz-KE-bpKQ',
  ])('rejects unsupported or malformed input: %s', (url) => {
    expect(() => normalizeYouTubeVideoUrl(url)).toThrow();
  });

  test.each([
    'https://www.youtube.com/playlist?list=PLfixture',
    'https://www.youtube.com/@fixture',
    'https://www.youtube.com/channel/UCfixture/videos',
  ])('explains the current collection boundary: %s', (url) => {
    expect(() => normalizeYouTubeVideoUrl(url)).toThrow('unsupported for now');
  });

  test('mixed video and playlist requires explicit video intent', () => {
    const url = `${CanonicalUrl}&list=PLfixture`;
    expect(() => normalizeYouTubeVideoUrl(url)).toThrow(
      'Choose the individual video',
    );
    expect(normalizeYouTubeVideoUrl(url, 'video').canonicalUrl).toBe(
      CanonicalUrl,
    );
  });
});

describe('YouTube extraction boundary', () => {
  test('returns bounded metadata, never the raw formats or signed media URL', async () => {
    subprocesses((child) => child.output(video()));
    const metadata = await new YouTubeAdapter().metadata(
      VideoId,
      new AbortController().signal,
    );
    expect(metadata).toEqual({
      id: VideoId,
      title: 'Finite fixture',
      durationSeconds: 12.5,
      description: 'Description',
      thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      creatorId: 'UC-fixture',
      creatorName: 'Fixture creator',
      uploadDate: '20261026',
      tags: ['one', 'two'],
    });
    expect(JSON.stringify(metadata)).not.toContain('signature');
    const extractionCall = vi
      .mocked(spawn)
      .mock.calls.find(
        ([, args]) =>
          Array.isArray(args) && args.includes('--dump-single-json'),
      );
    expect(extractionCall?.[1]).toEqual(
      expect.arrayContaining([
        '--ignore-config',
        '--no-plugin-dirs',
        '--no-remote-components',
        '--no-js-runtimes',
        '--js-runtimes',
        'node:fixture-node',
        '--skip-download',
        '--no-playlist',
        '--no-cookies',
        '--no-cookies-from-browser',
        '--',
        CanonicalUrl,
      ]),
    );
    expect(extractionCall?.[2]).toMatchObject({
      shell: false,
      windowsHide: true,
    });
  });

  test.each([
    { duration: 0 },
    { duration: -1 },
    { duration: null },
    { duration: '12' },
    { id: 'wrongwrongxx' },
    { title: 'x'.repeat(1025) },
    { tags: ['x'.repeat(257)] },
    { _type: 'playlist' },
  ])(
    'rejects invalid metadata without echoing its content: %j',
    async (overrides) => {
      subprocesses((child) => child.output(video(overrides)));
      await expect(
        new YouTubeAdapter().metadata(VideoId, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
    },
  );

  test.each([
    { is_live: true },
    { is_upcoming: true },
    { live_status: 'is_upcoming' },
    { live_status: 'post_live' },
    { availability: 'private' },
    { availability: 'premium_only' },
    { has_drm: true },
    { is_paid: true },
    { formats: [combined({ has_drm: true })] },
  ])('rejects unsupported availability: %j', async (overrides) => {
    subprocesses((child) => child.output(video(overrides)));
    await expect(
      new YouTubeAdapter().metadata(VideoId, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_VIDEO' });
  });

  test.each([
    'http://i.ytimg.com/x',
    'https://i.ytimg.com.evil.test/x',
    'https://user@i.ytimg.com/x',
  ])('drops unsupported artwork %s', async (thumbnail) => {
    subprocesses((child) => child.output(video({ thumbnail })));
    expect(
      (
        await new YouTubeAdapter().metadata(
          VideoId,
          new AbortController().signal,
        )
      ).thumbnail,
    ).toBeUndefined();
  });

  test('accepts a finite archived live recording and unlisted video', async () => {
    subprocesses((child) =>
      child.output(
        video({ live_status: 'was_live', availability: 'unlisted' }),
      ),
    );
    expect(
      (
        await new YouTubeAdapter().metadata(
          VideoId,
          new AbortController().signal,
        )
      ).durationSeconds,
    ).toBe(12.5);
  });

  test('invalid IDs cannot spawn a subprocess', async () => {
    await expect(
      new YouTubeAdapter().metadata(
        '--arbitrary-option',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_VIDEO_ID' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('health exposes a pin mismatch and extraction is disabled', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new FixtureChild();
      queueMicrotask(() => child.output('2026.10.25\n'));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const adapter = new YouTubeAdapter();
    expect(await adapter.health(new AbortController().signal)).toMatchObject({
      available: false,
      extractorVersion: '2026.10.25',
      message: expect.stringContaining('2026.10.26'),
    });
    await expect(
      adapter.resolve(VideoId, 1080, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  });

  test('health requires Node >=22 and reports a working runtime', async () => {
    subprocesses((child) => child.output(video()));
    expect(
      await new YouTubeAdapter().health(new AbortController().signal),
    ).toMatchObject({ available: true, extractorVersion: '2026.10.26' });
    vi.mocked(spawn).mockImplementation((executable) => {
      const child = new FixtureChild();
      queueMicrotask(() =>
        child.output(executable === 'fixture-node' ? 'v20.0.0' : '2026.10.26'),
      );
      return child as unknown as ReturnType<typeof spawn>;
    });
    expect(
      await new YouTubeAdapter().health(new AbortController().signal),
    ).toMatchObject({
      available: false,
      message: expect.stringContaining('Node >=22'),
    });
  });
});

describe('YouTube format selection', () => {
  test('selects combined SDR H264/AAC inside the ceiling, not higher HDR/VP9 or excessive height', async () => {
    subprocesses((child) =>
      child.output(
        video({
          formats: [
            combined({ format_id: 'too-high', height: 2160 }),
            combined({
              format_id: 'hdr',
              height: 1080,
              dynamic_range: 'HDR10',
              vcodec: 'vp9',
            }),
            combined({
              format_id: 'sdr-vp9',
              height: 1080,
              vcodec: 'vp9',
              acodec: 'opus',
            }),
            combined({
              format_id: 'preferred',
              height: 720,
              http_headers: { 'User-Agent': 'fixture-agent' },
            }),
          ],
        }),
      ),
    );
    const result = await new YouTubeAdapter().resolve(
      VideoId,
      1080,
      new AbortController().signal,
    );
    expect(result).toEqual({
      durationSeconds: 12.5,
      inputs: [
        {
          id: 'preferred',
          url: MediaUrl,
          headers: { 'User-Agent': 'fixture-agent' },
        },
      ],
    });
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.inputs[0]?.headers)).toBe(true);
  });

  test('returns actual split inputs with separately captured headers and format identities', async () => {
    subprocesses((child) =>
      child.output(
        video({
          http_headers: { Accept: '*/*' },
          formats: [
            combined({ format_id: '299', height: 1080, acodec: 'none' }),
            combined({
              format_id: 'audio-opus',
              height: null,
              vcodec: 'none',
              acodec: 'opus',
              tbr: 256,
            }),
            combined({
              format_id: '140',
              height: null,
              vcodec: 'none',
              url: `${MediaUrl}&audio=1`,
              http_headers: { 'User-Agent': 'audio-agent' },
            }),
          ],
        }),
      ),
    );
    expect(
      await new YouTubeAdapter().resolve(
        VideoId,
        1080,
        new AbortController().signal,
      ),
    ).toEqual({
      durationSeconds: 12.5,
      inputs: [
        { id: '299', url: MediaUrl, headers: { Accept: '*/*' } },
        {
          id: '140',
          url: `${MediaUrl}&audio=1`,
          headers: { Accept: '*/*', 'User-Agent': 'audio-agent' },
        },
      ],
    });
  });

  test('uses an actual fallback codec when H264/AAC is unavailable', async () => {
    subprocesses((child) =>
      child.output(
        video({ formats: [combined({ vcodec: 'vp9', acodec: 'opus' })] }),
      ),
    );
    expect(
      (
        await new YouTubeAdapter().resolve(
          VideoId,
          360,
          new AbortController().signal,
        )
      ).inputs[0]?.id,
    ).toBe('18');
  });

  test.each([
    { protocol: 'm3u8_native' },
    { protocol: 'http_dash_segments' },
    { format_note: 'SABR' },
    { url: 'https://127.0.0.1/videoplayback' },
    { url: 'http://rr1.googlevideo.com/videoplayback' },
    { url: 'https://rr1.googlevideo.com/sabr' },
    { fragments: [{ url: 'segment' }] },
    { height: 1080 },
    { acodec: 'none' },
  ])(
    'does not return unsupported/nonseekable candidates: %j',
    async (overrides) => {
      subprocesses((child) =>
        child.output(video({ formats: [combined(overrides)] })),
      );
      await expect(
        new YouTubeAdapter().resolve(
          VideoId,
          720,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'NO_PLAYABLE_FORMAT' });
    },
  );
});

describe('owned subprocess lifecycle', () => {
  test('cancellation before admission never spawns', async () => {
    const owner = new AbortController();
    owner.abort();
    await expect(
      runYouTubeProcess('fixture', [], owner.signal, 1000, 1024),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('active cancellation waits for closure, kills the owned tree and removes the abort listener', async () => {
    const child = new FixtureChild();
    useFixtureProcess(child);
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    let settled = false;
    const result = runYouTubeProcess(
      'fixture',
      ['private-url'],
      owner.signal,
      1000,
      1024,
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    void result.catch(() => {
      settled = true;
    });
    owner.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (process.platform === 'win32') {
      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        expect.objectContaining({ shell: false }),
      );
    } else {
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    }
    child.close(1);
    await assertion;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(child.stdout.listenerCount('data')).toBe(0);
  });

  test('stderr contributes to the output cap and is never exposed in the error', async () => {
    const child = new FixtureChild();
    useFixtureProcess(child);
    const result = runYouTubeProcess(
      'fixture',
      [],
      new AbortController().signal,
      1000,
      8,
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      message: 'YouTube tool output exceeded its limit.',
    });
    child.stderr.write('secret-signed-url');
    child.close(1);
    await assertion;
  });

  test('a process timeout escalates on Unix and still waits for close', async () => {
    if (process.platform === 'win32') {
      return;
    }
    vi.useFakeTimers();
    const child = new FixtureChild();
    useFixtureProcess(child);
    const result = runYouTubeProcess(
      'fixture',
      [],
      new AbortController().signal,
      10,
      1024,
    );
    const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1010);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    child.close(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  test('exit failures and malformed JSON cannot leak raw tool diagnostics', async () => {
    subprocesses((child) => {
      child.stderr.write('secret-signed-url');
      child.close(1);
    });
    await expect(
      new YouTubeAdapter().metadata(VideoId, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      message: expect.not.stringContaining('secret'),
    });
    subprocesses((child) => child.output('not json secret-signed-url'));
    await expect(
      new YouTubeAdapter().metadata(VideoId, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'INVALID_METADATA',
      message: expect.not.stringContaining('secret'),
    });
  });

  test('two active jobs retain their slots until close; queued cancellation never extracts and playback has priority', async () => {
    const active: FixtureChild[] = [];
    const children = subprocesses((child) => active.push(child));
    const adapter = new YouTubeAdapter();
    const signal = new AbortController().signal;
    const first = adapter.metadata(VideoId, signal);
    const second = adapter.metadata(VideoId, signal);
    // Flush version/runtime microtasks until both extraction jobs are active.
    await vi.waitFor(() => expect(active).toHaveLength(2));
    const queuedOwner = new AbortController();
    const queued = adapter.metadata(VideoId, queuedOwner.signal);
    const cancelledAssertion = expect(queued).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const order: string[] = [];
    const metadata = adapter
      .metadata(VideoId, signal)
      .then(() => order.push('metadata'));
    const playback = adapter
      .resolve(VideoId, 720, signal)
      .then(() => order.push('playback'));
    queuedOwner.abort();
    await cancelledAssertion;
    active[0]?.output(video());
    await vi.waitFor(() => expect(active).toHaveLength(3));
    active[2]?.output(video());
    await playback;
    expect(order).toEqual(['playback']);
    await vi.waitFor(() => expect(active).toHaveLength(4));
    active[3]?.output(video());
    active[1]?.output(video());
    await Promise.all([first, second, metadata]);
    // Four jobs, each with one pin check, runtime check and extraction.
    expect(children).toHaveLength(12);
  });
});
