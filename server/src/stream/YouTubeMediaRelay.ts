import dns from 'node:dns/promises';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpStreamSource } from './types.ts';

const MaxInputs = 64;
const MaxRequests = 8;
const MaxRedirects = 3;
const HeaderTimeoutMs = 10_000;
const RoutePrefix = '/api/youtube/media/';

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
blockedAddresses.addSubnet('2001:db8::', 32, 'ipv6');
const publicIpv6 = new net.BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');

export function isPublicYouTubeAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return !blockedAddresses.check(address, 'ipv4');
  }
  if (family === 6) {
    return (
      publicIpv6.check(address, 'ipv6') &&
      !blockedAddresses.check(address, 'ipv6')
    );
  }
  return false;
}

export function validateYouTubeMediaUrl(rawUrl: string): URL {
  const url = URL.parse(rawUrl);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.hostname.endsWith('.googlevideo.com')
  ) {
    throw new Error('Unsupported YouTube media destination.');
  }
  return url;
}

// Validation occurs in the socket's actual lookup on every hop, not in a
// separate check-then-fetch. Existing LAN media-server policy is unchanged.
const mediaLookup: LookupFunction = (hostname, options, callback) => {
  void dns
    .lookup(hostname, { all: true })
    .then((addresses) => {
      if (
        !addresses.length ||
        addresses.some(({ address }) => !isPublicYouTubeAddress(address))
      ) {
        callback(new Error('Blocked YouTube media address.'), '', 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        const first = addresses[0];
        if (!first) {
          callback(new Error('No media address.'), '', 0);
          return;
        }
        callback(null, first.address, first.family);
      }
    })
    .catch(() => callback(new Error('YouTube media DNS failed.'), '', 0));
};

export type YouTubeMediaResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
};

export type YouTubeMediaTransport = (
  url: URL,
  method: 'GET' | 'HEAD',
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<YouTubeMediaResponse>;

const requestMedia: YouTubeMediaTransport = (url, method, headers, signal) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        headers,
        signal,
        rejectUnauthorized: true,
        agent: new https.Agent({ lookup: mediaLookup, keepAlive: false }),
      },
      (response) =>
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
        }),
    );
    request.setTimeout(HeaderTimeoutMs, () =>
      request.destroy(new Error('YouTube media stalled.')),
    );
    // Covers DNS/connection setup too; socket inactivity alone does not.
    const deadline = setTimeout(
      () => request.destroy(new Error('YouTube media header deadline.')),
      HeaderTimeoutMs,
    );
    request.once('response', () => clearTimeout(deadline));
    request.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.once('close', () => clearTimeout(deadline));
    request.end();
  });

type MediaLease = {
  url: URL;
  headers: Record<string, string>;
  key: Buffer;
  requests: Set<AbortController>;
};

/** Session-owned byte forwarding. No client URL input, media cache or prefetch. */
export class YouTubeMediaRelay {
  private readonly inputs = new Map<string, MediaLease>();
  private requests = 0;

  constructor(
    private readonly transport: YouTubeMediaTransport = requestMedia,
  ) {}

  get status() {
    return { inputs: this.inputs.size, requests: this.requests };
  }

  register({
    url,
    headers = {},
    signal,
    baseUrl,
  }: {
    url: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    baseUrl: string;
  }): { source: HttpStreamSource; release: () => void } {
    const target = validateYouTubeMediaUrl(url);
    const base = URL.parse(baseUrl);
    if (
      !base ||
      base.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username ||
      base.password
    ) {
      throw new Error('The media relay must use the local server.');
    }
    if (signal.aborted || this.inputs.size >= MaxInputs) {
      throw new Error('Media input admission refused.');
    }
    const allowed = new Set([
      'user-agent',
      'accept',
      'accept-language',
      'origin',
      'referer',
      'sec-fetch-mode',
    ]);
    const forwarded: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (
        !allowed.has(name.toLowerCase()) ||
        typeof value !== 'string' ||
        value.length > 8192 ||
        /[\r\n]/.test(value)
      ) {
        throw new Error('Unsupported YouTube media header.');
      }
      forwarded[name.toLowerCase()] = value;
    }
    const id = randomBytes(16).toString('hex');
    const key = randomBytes(32);
    const lease: MediaLease = {
      url: target,
      headers: forwarded,
      key,
      requests: new Set(),
    };
    const release = () => {
      signal.removeEventListener('abort', release);
      if (!this.inputs.delete(id)) {
        return;
      }
      for (const request of lease.requests) {
        request.abort();
      }
    };
    this.inputs.set(id, lease);
    signal.addEventListener('abort', release, { once: true });
    return {
      source: new HttpStreamSource(new URL(RoutePrefix + id, base).href, {
        Authorization: 'Bearer ' + key.toString('hex'),
      }),
      release,
    };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = URL.parse(request.url ?? '', 'http://127.0.0.1');
    const id = url?.pathname.startsWith(RoutePrefix)
      ? url.pathname.slice(RoutePrefix.length)
      : '';
    const lease = id ? this.inputs.get(id) : undefined;
    const authorization = request.headers.authorization;
    const supplied =
      typeof authorization === 'string' &&
      /^Bearer [0-9a-f]{64}$/.test(authorization)
        ? Buffer.from(authorization.slice(7), 'hex')
        : undefined;
    if (
      !lease ||
      !supplied ||
      url?.search ||
      !timingSafeEqual(supplied, lease.key)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    const range = request.headers.range;
    if (range !== undefined && !/^bytes=\d+-\d*$/.test(range)) {
      response.writeHead(416).end();
      return;
    }
    if (this.requests >= MaxRequests) {
      response.writeHead(503).end();
      return;
    }
    const controller = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    lease.requests.add(controller);
    this.requests++;
    let body: Readable | undefined;
    try {
      let destination = lease.url;
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        const upstream = await this.transport(
          destination,
          request.method,
          { ...lease.headers, ...(range ? { range } : {}) },
          controller.signal,
        );
        body = upstream.body;
        if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
          body.destroy();
          const location = upstream.headers.location;
          if (redirects >= MaxRedirects || typeof location !== 'string') {
            throw new Error('Invalid media redirect.');
          }
          destination = validateYouTubeMediaUrl(
            new URL(location, destination).href,
          );
          continue;
        }
        if (
          ![200, 206, 416].includes(upstream.statusCode) ||
          (range && upstream.statusCode === 200)
        ) {
          throw new Error('Media upstream unavailable or not range-seekable.');
        }
        const headers: Record<string, string> = { 'cache-control': 'no-store' };
        for (const name of [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
        ]) {
          const value = upstream.headers[name];
          if (typeof value === 'string') {
            headers[name] = value;
          }
        }
        response.writeHead(upstream.statusCode, headers);
        await pipeline(body, response, { signal: controller.signal });
        break;
      }
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502).end('Media input unavailable.');
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      body?.destroy();
      controller.abort();
      lease.requests.delete(controller);
      this.requests--;
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
    }
  }
}
