import dns from 'node:dns/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import type { YouTubeMediaTransport } from './YouTubeMediaRelay.ts';
import {
  isPublicYouTubeAddress,
  validateYouTubeMediaUrl,
  YouTubeMediaRelay,
} from './YouTubeMediaRelay.ts';

async function withRelay(
  transport: YouTubeMediaTransport | undefined,
  action: (fixture: {
    relay: YouTubeMediaRelay;
    baseUrl: string;
    owner: AbortController;
  }) => Promise<void>,
) {
  const relay = new YouTubeMediaRelay(transport);
  const owner = new AbortController();
  const server = createServer((request, response) => {
    void relay.handle(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture address.');
  try {
    await action({ relay, owner, baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    owner.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const mediaUrl =
  'https://a.googlevideo.com/videoplayback?private-signature=fixture';
const bytes: YouTubeMediaTransport = async () => ({
  statusCode: 206,
  headers: {
    'content-range': 'bytes 1-3/5',
    'content-length': '3',
    'content-type': 'video/mp4',
  },
  body: Readable.from([Buffer.from('bcd')]),
});

describe('YouTube media boundary', () => {
  test.each([
    'http://a.googlevideo.com/x',
    'https://googlevideo.com/x',
    'https://a.googlevideo.com.evil.test/x',
    'https://user@a.googlevideo.com/x',
    'https://127.0.0.1/x',
    'file:///tmp/movie',
    'https://a.googlevideo.com:8443/x',
  ])('rejects unsupported destination %s', (url) => {
    expect(() => validateYouTubeMediaUrl(url)).toThrow('Unsupported');
  });

  test.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '2001:db8::1',
  ])('refuses nonpublic socket address %s', (address) => {
    expect(isPublicYouTubeAddress(address)).toBe(false);
  });

  test.each(['8.8.8.8', '142.250.1.1', '2a00:1450:4001::1'])(
    'allows public socket address %s',
    (address) => {
      expect(isPublicYouTubeAddress(address)).toBe(true);
    },
  );

  test('forwards a range and captured media headers, not the relay credential', async () => {
    const transport = vi.fn(bytes);
    await withRelay(transport, async ({ relay, owner, baseUrl }) => {
      const lease = relay.register({
        url: mediaUrl,
        headers: { 'User-Agent': 'fixture-agent' },
        signal: owner.signal,
        baseUrl,
      });
      const response = await fetch(lease.source.path, {
        headers: { ...lease.source.extraHeaders, Range: 'bytes=1-3' },
      });
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('bcd');
      expect(response.headers.get('content-range')).toBe('bytes 1-3/5');
      expect(transport.mock.calls[0]?.[2]).toEqual({
        'user-agent': 'fixture-agent',
        range: 'bytes=1-3',
      });
      expect(lease.source.path).not.toContain('private-signature');
      lease.source.redact();
      expect(lease.source.extraHeaders.Authorization).toBe('REDACTED');
      await expect.poll(() => relay.status.requests).toBe(0);
      lease.release();
      expect(relay.status.inputs).toBe(0);
    });
  });

  test('unknown keys and caller URL parameters never cause upstream requests', async () => {
    const transport = vi.fn(bytes);
    await withRelay(transport, async ({ relay, owner, baseUrl }) => {
      const { source } = relay.register({
        url: mediaUrl,
        signal: owner.signal,
        baseUrl,
      });
      expect((await fetch(source.path)).status).toBe(404);
      expect(
        (
          await fetch(source.path + '?url=http://127.0.0.1', {
            headers: source.extraHeaders,
          })
        ).status,
      ).toBe(404);
      expect(transport).not.toHaveBeenCalled();
    });
  });

  test.each([
    'http://127.0.0.1/private',
    'https://127.0.0.1/private',
    'file:///tmp/private',
    'https://a.googlevideo.com.evil.test/private',
  ])(
    'refuses redirect %s before requesting its destination',
    async (location) => {
      const transport = vi.fn<YouTubeMediaTransport>(async () => ({
        statusCode: 302,
        headers: { location },
        body: Readable.from([]),
      }));
      await withRelay(transport, async ({ relay, owner, baseUrl }) => {
        const { source } = relay.register({
          url: mediaUrl,
          signal: owner.signal,
          baseUrl,
        });
        const response = await fetch(source.path, {
          headers: source.extraHeaders,
        });
        expect(response.status).toBe(502);
        expect(await response.text()).toBe('Media input unavailable.');
        expect(transport).toHaveBeenCalledTimes(1);
      });
    },
  );

  test('allows bounded same-provider redirects and preserves the range', async () => {
    const transport = vi.fn<YouTubeMediaTransport>(
      async (url, method, headers, signal) =>
        url.hostname === 'a.googlevideo.com'
          ? {
              statusCode: 302,
              headers: { location: 'https://b.googlevideo.com/media' },
              body: Readable.from([]),
            }
          : bytes(url, method, headers, signal),
    );
    await withRelay(transport, async ({ relay, owner, baseUrl }) => {
      const { source } = relay.register({
        url: mediaUrl,
        signal: owner.signal,
        baseUrl,
      });
      const response = await fetch(source.path, {
        headers: { ...source.extraHeaders, Range: 'bytes=1-3' },
      });
      expect(await response.text()).toBe('bcd');
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1]?.[2]).toEqual({ range: 'bytes=1-3' });
    });
  });

  test('the real HTTPS transport blocks a private DNS answer at socket lookup', async () => {
    // Vitest infers dns.lookup's scalar overload; production calls all:true.
    const answers = [{ address: '127.0.0.1', family: 4 }];
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue(
        answers as unknown as Awaited<ReturnType<typeof dns.lookup>>,
      );
    try {
      await withRelay(undefined, async ({ relay, owner, baseUrl }) => {
        const { source } = relay.register({
          url: mediaUrl,
          signal: owner.signal,
          baseUrl,
        });
        const response = await fetch(source.path, {
          headers: source.extraHeaders,
        });
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain('private-signature');
        expect(lookup).toHaveBeenCalledWith('a.googlevideo.com', { all: true });
      });
    } finally {
      lookup.mockRestore();
    }
  });

  test('owner cancellation aborts in-flight forwarding and unregisters its input', async () => {
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = vi.fn<YouTubeMediaTransport>(
      async (_url, _method, _headers, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          started?.();
        }),
    );
    await withRelay(transport, async ({ relay, owner, baseUrl }) => {
      const { source } = relay.register({
        url: mediaUrl,
        signal: owner.signal,
        baseUrl,
      });
      const pending = fetch(source.path, { headers: source.extraHeaders });
      await entered;
      owner.abort();
      expect((await pending).status).toBe(502);
      await expect.poll(() => relay.status).toEqual({ inputs: 0, requests: 0 });
      expect(
        (await fetch(source.path, { headers: source.extraHeaders })).status,
      ).toBe(404);
    });
  });
});
