import { injectable } from 'inversify';
import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as waitForMedia } from 'node:timers/promises';
import PQueue from 'p-queue';
import { z } from 'zod/v4';
import { validateYouTubeMediaUrl } from '../../stream/YouTubeMediaRelay.ts';
import type { HttpStreamSource } from '../../stream/types.ts';
import { FfprobeMediaInfoSchema } from '../../types/ffmpeg.ts';
import type { FfprobeMediaInfo } from '../../types/ffmpeg.ts';

import {
  YouTubeExtractorVersion as ExtractorVersion,
  youtubeExecutable,
} from './YouTubeTools.ts';
const VideoId = /^[A-Za-z0-9_-]{11}$/;
const MaxOutputBytes = 8 * 1024 * 1024;
// Fresh Googlevideo URLs can reject early reads with 403. Like yt-dlp's
// downloader, age the captured set before exposing it to probes or playback.
const MediaAvailabilityDelayMs = 7000;
const MediaProbeTimeoutMs = 20_000;
const IncompleteEnumeration =
  /incomplete data received|detected youtube feed looping|repeated.*continuation|same.*continuation|skipping the rest/i;

export type YouTubeErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_COLLECTION'
  | 'AMBIGUOUS_URL'
  | 'INVALID_VIDEO_ID'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'TOOL_UNAVAILABLE'
  | 'VERSION_MISMATCH'
  | 'RUNTIME_UNAVAILABLE'
  | 'PROCESS_FAILED'
  | 'RATE_LIMITED'
  | 'ACCESS_CHALLENGE'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'INVALID_METADATA'
  | 'UNSUPPORTED_VIDEO'
  | 'NO_PLAYABLE_FORMAT'
  | 'PENDING_METADATA'
  | 'SAFETY_LIMIT';

export class YouTubeError extends Error {
  constructor(
    readonly code: YouTubeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

function cancelled(): YouTubeError {
  return new YouTubeError('CANCELLED', 'YouTube operation cancelled.');
}

function assertVideoId(videoId: string): void {
  if (!VideoId.test(videoId)) {
    throw new YouTubeError('INVALID_VIDEO_ID', 'Invalid YouTube video ID.');
  }
}

export function normalizeYouTubeVideoUrl(
  raw: string,
  intent?: 'video',
): { videoId: string; canonicalUrl: string } {
  const url = raw.length <= 4096 ? URL.parse(raw) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
      url.hostname,
    )
  ) {
    throw new YouTubeError('INVALID_URL', 'Use an HTTPS YouTube video URL.');
  }
  if (
    url.pathname === '/playlist' ||
    /^\/(?:@|channel\/|c\/|user\/)/.test(url.pathname)
  ) {
    throw new YouTubeError(
      'UNSUPPORTED_COLLECTION',
      'Playlists and creators are unsupported for now; import one video.',
    );
  }
  if (url.searchParams.has('list') && intent !== 'video') {
    throw new YouTubeError(
      'AMBIGUOUS_URL',
      'Choose the individual video explicitly when a URL includes a playlist.',
    );
  }
  const videoId =
    url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : url.pathname === '/watch'
        ? url.searchParams.getAll('v').length === 1
          ? (url.searchParams.get('v') ?? '')
          : ''
        : /^\/(shorts|embed)\/[^/]+\/?$/.test(url.pathname)
          ? (url.pathname.split('/')[2] ?? '')
          : '';
  assertVideoId(videoId);
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export type YouTubeInput =
  | { kind: 'video'; id: string; canonicalUrl: string }
  | { kind: 'playlist'; id: string; canonicalUrl: string }
  | { kind: 'creator'; id: string; canonicalUrl: string };

export function normalizeYouTubeUrl(
  raw: string,
  intent?: 'video' | 'playlist',
): YouTubeInput {
  const url = raw.length <= 4096 ? URL.parse(raw) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
      url.hostname,
    )
  ) {
    throw new YouTubeError(
      'INVALID_URL',
      'Use an HTTPS YouTube video, playlist or creator URL.',
    );
  }
  const videoPath =
    url.hostname === 'youtu.be' ||
    url.pathname === '/watch' ||
    /^\/(shorts|embed)\/[^/]+\/?$/.test(url.pathname);
  const lists = url.searchParams.getAll('list');
  if (videoPath && lists.length && !intent) {
    throw new YouTubeError(
      'AMBIGUOUS_URL',
      'Choose video or playlist for a link containing both.',
    );
  }
  if (url.pathname === '/playlist' || (videoPath && intent === 'playlist')) {
    const id = lists.length === 1 ? lists[0] : '';
    if (!id || !/^[A-Za-z0-9_-]{2,128}$/.test(id)) {
      throw new YouTubeError('INVALID_URL', 'Invalid YouTube playlist ID.');
    }
    return {
      kind: 'playlist',
      id,
      canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
    };
  }
  if (videoPath) {
    const { videoId, canonicalUrl } = normalizeYouTubeVideoUrl(raw, 'video');
    return { kind: 'video', id: videoId, canonicalUrl };
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new YouTubeError('INVALID_URL', 'Invalid creator URL.');
      }
    });
  let creatorPath: string | undefined;
  if (
    segments[0]?.startsWith('@') &&
    /^@[\p{L}\p{N}_.·-]{1,30}$/u.test(segments[0]) &&
    segments.length <= 2 &&
    (!segments[1] || ['videos', 'shorts', 'streams'].includes(segments[1]))
  ) {
    creatorPath = `/@${encodeURIComponent(segments[0].slice(1))}`;
  } else if (
    ['channel', 'c', 'user'].includes(segments[0] ?? '') &&
    segments[1] &&
    /^[\p{L}\p{N}_.-]{1,100}$/u.test(segments[1]) &&
    segments.length <= 3 &&
    (!segments[2] || ['videos', 'shorts', 'streams'].includes(segments[2]))
  ) {
    if (
      segments[0] === 'channel' &&
      !/^UC[A-Za-z0-9_-]{22}$/.test(segments[1])
    ) {
      throw new YouTubeError(
        'INVALID_URL',
        'Invalid canonical YouTube channel ID.',
      );
    }
    creatorPath = `/${segments[0]}/${encodeURIComponent(segments[1])}`;
  }
  if (!creatorPath) {
    throw new YouTubeError(
      'INVALID_URL',
      'Use a video, playlist, handle or channel URL.',
    );
  }
  return {
    kind: 'creator',
    id: creatorPath,
    canonicalUrl: `https://www.youtube.com${creatorPath}/videos`,
  };
}

export function youtubeCollectionLimit(): number {
  const value = Number(
    process.env.TUNARR_YOUTUBE_MAX_COLLECTION_ENTRIES ?? 1000,
  );
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new YouTubeError(
      'SAFETY_LIMIT',
      'Configure TUNARR_YOUTUBE_MAX_COLLECTION_ENTRIES between 1 and 10000.',
    );
  }
  return value;
}

export type YouTubeListing = {
  kind: 'playlist' | 'creator_uploads';
  id: string;
  title: string;
  entries: Array<{
    videoId: string | null;
    title: string;
    unavailable: boolean;
  }>;
};
const ListingSchema = z.object({
  _type: z.literal('playlist'),
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(1024),
  channel_id: z.string().nullish(),
  playlist_count: z.number().int().nonnegative().nullish(),
  entries: z
    .array(
      z
        .object({
          id: z.string().nullish(),
          title: z.string().max(1024).nullish(),
          availability: z.string().max(64).nullish(),
        })
        .nullable(),
    )
    .max(10001),
});

/** No shell or raw diagnostics. Settlement waits for owned process closure. */
export function runYouTubeProcess(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(cancelled());
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > MaxOutputBytes
  ) {
    return Promise.reject(
      new YouTubeError('PROCESS_FAILED', 'Invalid YouTube process limits.'),
    );
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // pkg's CLI mode must also reach the Node helper spawned by yt-dlp.
        // Keep it child-local so the owning Tunarr process is unchanged.
        env: { ...process.env, PKG_EXECPATH: 'PKG_INVOKE_NODEJS' },
      });
    } catch {
      reject(
        new YouTubeError('TOOL_UNAVAILABLE', 'YouTube tool could not start.'),
      );
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = '';
    let incompleteEnumeration = false;
    let failure: YouTubeError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let treeKill: Promise<void> | undefined;
    const killGroup = (killSignal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // ESRCH: the owned group has already closed.
      }
    };
    const stop = (error: YouTubeError) => {
      if (failure) {
        return;
      }
      failure = error;
      if (process.platform === 'win32') {
        if (child.pid) {
          const pid = child.pid;
          treeKill = new Promise<void>((done) => {
            const cleanupFailed = () => {
              failure = new YouTubeError(
                'PROCESS_FAILED',
                'YouTube process tree cleanup failed.',
              );
              child.kill();
            };
            let killer: ChildProcess;
            try {
              killer = spawn(
                path.join(
                  process.env.SystemRoot ?? 'C:\\Windows',
                  'System32',
                  'taskkill.exe',
                ),
                ['/PID', String(pid), '/T', '/F'],
                { shell: false, windowsHide: true, stdio: 'ignore' },
              );
            } catch {
              cleanupFailed();
              done();
              return;
            }
            const deadline = setTimeout(() => {
              cleanupFailed();
              killer.kill();
            }, 5000);
            killer.once('error', cleanupFailed);
            killer.once('close', (code) => {
              clearTimeout(deadline);
              killer.removeListener('error', cleanupFailed);
              if (code !== 0) {
                cleanupFailed();
              }
              done();
            });
          });
        }
      } else {
        killGroup('SIGTERM');
        escalation = setTimeout(() => killGroup('SIGKILL'), 1000);
      }
    };
    const abort = () => stop(cancelled());
    const timeout = setTimeout(
      () => stop(new YouTubeError('TIMEOUT', 'YouTube tool timed out.')),
      timeoutMs,
    );
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stop(
          new YouTubeError(
            'OUTPUT_LIMIT',
            'YouTube tool output exceeded its limit.',
          ),
        );
      } else if (stdout && !failure) {
        chunks.push(Buffer.from(chunk));
      }
    };
    const stdout = (chunk: Buffer) => collect(chunk, true);
    const stderr = (chunk: Buffer) => {
      collect(chunk, false);
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192);
      incompleteEnumeration ||= IncompleteEnumeration.test(diagnostic);
    };
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    const onError = () => {
      stop(
        new YouTubeError('TOOL_UNAVAILABLE', 'YouTube tool could not start.'),
      );
    };
    child.once('error', onError);
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      child.removeListener('error', onError);
      child.stdout.removeListener('data', stdout);
      child.stderr.removeListener('data', stderr);
      if (process.platform !== 'win32') {
        killGroup('SIGKILL');
      }
      const finish = () => {
        if (failure) {
          reject(failure);
        } else if (code !== 0) {
          if (/429|too many requests|rate.?limit/i.test(diagnostic)) {
            reject(
              new YouTubeError(
                'RATE_LIMITED',
                'YouTube is rate limiting this server. Wait before retrying.',
              ),
            );
          } else if (
            /confirm.*bot|not a bot|po.token|challenge|sabr/i.test(diagnostic)
          ) {
            reject(
              new YouTubeError(
                'ACCESS_CHALLENGE',
                'YouTube requires an access challenge or unsupported transport. This source does not use cookies or token services.',
              ),
            );
          } else if (
            /private video|video unavailable|video.*removed|members.only|sign.in|payment|not available/i.test(
              diagnostic,
            )
          ) {
            reject(
              new YouTubeError(
                'UNAVAILABLE',
                'This YouTube video is inaccessible, unavailable, or requires an account or payment.',
              ),
            );
          } else if (
            /network|timed out|connection|http error 5\d\d|unable to download/i.test(
              diagnostic,
            )
          ) {
            reject(
              new YouTubeError(
                'NETWORK',
                'YouTube could not be reached. Check server connectivity and retry later.',
              ),
            );
          } else {
            reject(
              new YouTubeError(
                'PROCESS_FAILED',
                'YouTube extraction failed. Check public accessibility and tool provisioning.',
              ),
            );
          }
        } else if (incompleteEnumeration) {
          reject(
            new YouTubeError(
              'NETWORK',
              'YouTube enumeration was incomplete. The previous collection snapshot was retained.',
            ),
          );
        } else {
          resolve(Buffer.concat(chunks).toString('utf8'));
        }
      };
      if (treeKill) {
        void treeKill.then(finish, () => {
          reject(
            new YouTubeError(
              'PROCESS_FAILED',
              'YouTube process cleanup failed.',
            ),
          );
        });
      } else {
        finish();
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

export type YouTubeVideoMetadata = {
  id: string;
  title: string;
  durationSeconds: number;
  description?: string;
  thumbnail?: string;
  creatorId?: string;
  creatorName?: string;
  uploadDate?: string;
  tags: string[];
  categories?: string[];
};

export type YouTubeResolvedMedia = {
  durationSeconds: number;
  inputs: Array<{ id: string; url: string; headers: Record<string, string> }>;
};

const optionalText = (max: number) => z.string().max(max).nullish();
const HeadersSchema = z.record(z.string().max(128), z.string().max(8192));
const FormatSchema = z.object({
  format_id: z.string().min(1).max(128),
  url: z.string().max(32768).optional(),
  protocol: optionalText(64),
  vcodec: optionalText(128),
  acodec: optionalText(128),
  height: z.number().finite().positive().nullish(),
  tbr: z.number().finite().nonnegative().nullish(),
  dynamic_range: optionalText(64),
  format_note: optionalText(1024),
  has_drm: z.boolean().nullish(),
  http_headers: HeadersSchema.optional(),
  fragments: z.array(z.unknown()).max(32768).optional(),
});
const MetadataSchema = z.object({
  id: z.string().regex(VideoId),
  _type: z.literal('video').optional(),
  title: z.string().min(1).max(1024),
  duration: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000)
    .nullish(),
  description: optionalText(65536),
  thumbnail: optionalText(4096),
  channel_id: optionalText(256),
  channel: optionalText(1024),
  uploader: optionalText(1024),
  upload_date: z
    .string()
    .regex(/^\d{8}$/)
    .nullish(),
  tags: z.array(z.string().max(256)).max(256).nullish(),
  categories: z.array(z.string().max(256)).max(64).nullish(),
  is_live: z.boolean().nullish(),
  is_upcoming: z.boolean().nullish(),
  live_status: optionalText(64),
  availability: optionalText(64),
  has_drm: z.boolean().nullish(),
  is_paid: z.boolean().nullish(),
  formats: z.array(FormatSchema).max(2048).optional(),
  http_headers: HeadersSchema.optional(),
});
type ExtractedVideo = z.infer<typeof MetadataSchema> & { duration: number };
type Format = z.infer<typeof FormatSchema>;

function parseVideo(json: string, videoId: string): ExtractedVideo {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new YouTubeError(
      'INVALID_METADATA',
      'YouTube returned invalid JSON.',
    );
  }
  const parsed = MetadataSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== videoId) {
    throw new YouTubeError(
      'INVALID_METADATA',
      'YouTube returned invalid video metadata.',
    );
  }
  const video = parsed.data;
  if (
    video.is_live ||
    video.is_upcoming ||
    video.has_drm ||
    video.is_paid ||
    (video.formats &&
      video.formats.length > 0 &&
      video.formats.every((format) => format.has_drm)) ||
    (video.live_status &&
      !['not_live', 'was_live'].includes(video.live_status)) ||
    (video.availability && !['public', 'unlisted'].includes(video.availability))
  ) {
    throw new YouTubeError(
      'UNSUPPORTED_VIDEO',
      'Only accessible finite recorded videos without payment, login or DRM are supported.',
    );
  }
  if (!video.duration) {
    throw new YouTubeError(
      'PENDING_METADATA',
      'A finite positive duration is still missing. This entry cannot be scheduled.',
    );
  }
  return { ...video, duration: video.duration };
}

function thumbnailUrl(raw: string | null | undefined): string | undefined {
  const url = raw ? URL.parse(raw) : null;
  if (
    url &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === 'ytimg.com' || url.hostname.endsWith('.ytimg.com'))
  ) {
    return url.href;
  }
  return;
}

function playable(format: Format): boolean {
  if (
    !format.url ||
    format.protocol !== 'https' ||
    format.has_drm ||
    /sabr/i.test(format.format_note ?? '') ||
    (format.fragments && format.fragments.length > 0)
  ) {
    return false;
  }
  try {
    const url = validateYouTubeMediaUrl(format.url);
    return url.pathname === '/videoplayback';
  } catch {
    return false;
  }
}

function hasVideo(format: Format): boolean {
  return Boolean(format.vcodec && format.vcodec !== 'none');
}

function hasAudio(format: Format): boolean {
  return Boolean(format.acodec && format.acodec !== 'none');
}

function h264(format: Format): boolean {
  return /^(?:avc1|h264)/i.test(format.vcodec ?? '');
}

function aac(format: Format): boolean {
  return /^(?:mp4a|aac)/i.test(format.acodec ?? '');
}

function selectInputs(
  video: ExtractedVideo,
  maxHeight: number,
): YouTubeResolvedMedia {
  const formats = (video.formats ?? []).filter(playable);
  const videos = formats.filter(
    (format) =>
      hasVideo(format) && Boolean(format.height && format.height <= maxHeight),
  );
  const audios = formats.filter(
    (format) => !hasVideo(format) && hasAudio(format),
  );
  audios.sort(
    (a, b) => Number(aac(b)) - Number(aac(a)) || (b.tbr ?? 0) - (a.tbr ?? 0),
  );
  const audio = audios[0];
  const candidates = videos.filter((format) => hasAudio(format) || audio);
  const preference = (format: Format) =>
    Number(!format.dynamic_range || format.dynamic_range === 'SDR') * 4 +
    Number(h264(format)) * 2 +
    Number(hasAudio(format) ? aac(format) : audio && aac(audio));
  candidates.sort(
    (a, b) =>
      preference(b) - preference(a) ||
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.tbr ?? 0) - (a.tbr ?? 0),
  );
  const selected = candidates[0];
  if (!selected) {
    throw new YouTubeError(
      'NO_PLAYABLE_FORMAT',
      'No supported seekable YouTube formats fit the quality ceiling.',
    );
  }
  const tracks = hasAudio(selected)
    ? [selected]
    : audio
      ? [selected, audio]
      : [];
  const inputs = tracks.map((format) => {
    if (!format.url) {
      throw new YouTubeError(
        'NO_PLAYABLE_FORMAT',
        'Selected YouTube format has no URL.',
      );
    }
    return Object.freeze({
      id: format.format_id,
      url: format.url,
      headers: Object.freeze({ ...video.http_headers, ...format.http_headers }),
    });
  });
  if (new Set(inputs.map(({ id }) => id)).size !== inputs.length) {
    throw new YouTubeError(
      'INVALID_METADATA',
      'YouTube returned duplicate selected format IDs.',
    );
  }
  Object.freeze(inputs);
  return Object.freeze({ durationSeconds: video.duration, inputs });
}

@injectable()
export class YouTubeAdapter {
  private readonly queue = new PQueue({ concurrency: 2 });
  // A probe's relay can need fresh extraction. Leave the other tool slot
  // available instead of letting two probes wait on their own full queue.
  private readonly probeQueue = new PQueue({ concurrency: 1 });

  async metadata(
    videoId: string,
    signal: AbortSignal,
  ): Promise<YouTubeVideoMetadata> {
    assertVideoId(videoId);
    return this.job(signal, 0, async (owner) => {
      const video = await this.extract(videoId, owner);
      return {
        id: video.id,
        title: video.title,
        durationSeconds: video.duration,
        description: video.description ?? undefined,
        thumbnail: thumbnailUrl(video.thumbnail),
        creatorId: video.channel_id ?? undefined,
        creatorName: video.channel ?? video.uploader ?? undefined,
        uploadDate: video.upload_date ?? undefined,
        tags: [...(video.tags ?? [])],
        categories: video.categories ? [...video.categories] : undefined,
      };
    });
  }

  async listing(
    input: Exclude<YouTubeInput, { kind: 'video' }>,
    signal: AbortSignal,
  ): Promise<YouTubeListing> {
    return this.job(signal, 0, async (owner) => {
      this.assertVersion(await this.version(owner));
      const runtime = await this.runtime(owner);
      const read = async (url: string, limit: number) => {
        const json = await runYouTubeProcess(
          this.executable(),
          [
            ...this.extractorArguments(runtime),
            '--flat-playlist',
            '--yes-playlist',
            '--abort-on-error',
            // The pinned extractor reports a repeated feed only at debug
            // level, then returns success. Capture privately to reject it.
            '--verbose',
            '--playlist-end',
            String(limit),
            '--',
            url,
          ],
          owner,
          25_000,
          MaxOutputBytes,
        );
        try {
          return ListingSchema.parse(JSON.parse(json));
        } catch {
          throw new YouTubeError(
            'INVALID_METADATA',
            'YouTube returned invalid collection metadata.',
          );
        }
      };
      let channelId: string | undefined;
      let playlistId = input.id;
      if (input.kind === 'creator') {
        const canonical = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(input.id);
        channelId =
          canonical?.[1] ??
          (await read(input.canonicalUrl, 1)).channel_id ??
          undefined;
        if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
          throw new YouTubeError(
            'INVALID_METADATA',
            'Could not resolve a canonical creator channel ID.',
          );
        }
        // The UU playlist is all uploads, not only the creator videos tab.
        playlistId = `UU${channelId.slice(2)}`;
      }
      const limit = youtubeCollectionLimit();
      const listing = await read(
        `https://www.youtube.com/playlist?list=${playlistId}`,
        limit + 1,
      );
      if (listing.id !== playlistId) {
        throw new YouTubeError(
          'INVALID_METADATA',
          'YouTube returned a different collection.',
        );
      }
      if (
        listing.entries.length > limit ||
        (listing.playlist_count ?? 0) > limit
      ) {
        throw new YouTubeError(
          'SAFETY_LIMIT',
          `Collection exceeds the configured ${limit}-entry limit. No truncated snapshot was published.`,
        );
      }
      if (
        listing.playlist_count != null &&
        listing.playlist_count !== listing.entries.length
      ) {
        throw new YouTubeError(
          'NETWORK',
          'YouTube did not enumerate the complete collection. The previous snapshot was retained.',
        );
      }
      return {
        kind: input.kind === 'creator' ? 'creator_uploads' : 'playlist',
        id: channelId ?? playlistId,
        title: listing.title,
        entries: listing.entries.map((entry) => ({
          videoId: entry?.id && VideoId.test(entry.id) ? entry.id : null,
          title: entry?.title ?? 'Unidentified entry',
          unavailable:
            !!entry?.availability &&
            !['public', 'unlisted'].includes(entry.availability),
        })),
      };
    });
  }

  async resolve(
    videoId: string,
    maxHeight: number,
    signal: AbortSignal,
  ): Promise<YouTubeResolvedMedia> {
    assertVideoId(videoId);
    if (!Number.isSafeInteger(maxHeight) || maxHeight <= 0) {
      throw new YouTubeError(
        'NO_PLAYABLE_FORMAT',
        'Provide a positive integer quality ceiling.',
      );
    }
    return this.job(signal, 10, async (owner) => {
      const resolved = selectInputs(
        await this.extract(videoId, owner),
        maxHeight,
      );
      await waitForMedia(MediaAvailabilityDelayMs, undefined, {
        signal: owner,
      });
      return resolved;
    });
  }

  async probe(
    source: HttpStreamSource,
    executable: string,
    signal: AbortSignal,
  ): Promise<FfprobeMediaInfo> {
    const url = URL.parse(source.path);
    const authorization = source.extraHeaders.Authorization;
    if (
      !url ||
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/youtube\/media\/[0-9a-f]{32}$/.test(url.pathname) ||
      !authorization ||
      !/^Bearer [0-9a-f]{64}$/.test(authorization)
    ) {
      throw new YouTubeError(
        'NO_PLAYABLE_FORMAT',
        'A probe requires an owned YouTube relay input.',
      );
    }
    return this.job(
      signal,
      10,
      (probeOwner) =>
        this.job(probeOwner, 10, async (owner) => {
          const json = await runYouTubeProcess(
            executable,
            [
              '-v',
              'error',
              '-protocol_whitelist',
              'http,tcp',
              '-rw_timeout',
              String(MediaProbeTimeoutMs * 1000),
              '-probesize',
              '1048576',
              '-analyzeduration',
              '1000000',
              '-headers',
              `Authorization: ${authorization}\r\n`,
              '-show_streams',
              '-show_format',
              '-of',
              'json',
              source.path,
            ],
            owner,
            MediaProbeTimeoutMs,
            1024 * 1024,
          );
          try {
            return FfprobeMediaInfoSchema.parse(JSON.parse(json));
          } catch {
            throw new YouTubeError(
              'INVALID_METADATA',
              'Selected media could not be probed safely.',
            );
          }
        }),
      this.probeQueue,
    );
  }

  async health(signal: AbortSignal): Promise<{
    available: boolean;
    extractorVersion?: string;
    message: string;
  }> {
    return this.job(signal, 0, async (owner) => {
      let extractorVersion: string | undefined;
      try {
        extractorVersion = await this.version(owner);
        this.assertVersion(extractorVersion);
        await this.runtime(owner);
        return {
          available: true,
          extractorVersion,
          message: 'YouTube extractor and Node runtime are available.',
        };
      } catch (error) {
        if (owner.aborted) {
          throw cancelled();
        }
        return {
          available: false,
          extractorVersion,
          message:
            error instanceof YouTubeError
              ? error.message
              : 'YouTube tooling is unavailable.',
        };
      }
    });
  }

  private async job<T>(
    signal: AbortSignal,
    priority: number,
    action: (owner: AbortSignal) => Promise<T>,
    queue = this.queue,
  ): Promise<T> {
    if (signal.aborted) {
      throw cancelled();
    }
    // PQueue may reject an active aborted task before its process closes. Only
    // queue admission uses its signal; active cancellation is joined by the runner.
    const queued = new AbortController();
    let rejectQueued: ((error: YouTubeError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectQueued = reject;
    });
    const cancelQueued = () => {
      queued.abort();
      rejectQueued?.(cancelled());
    };
    signal.addEventListener('abort', cancelQueued, { once: true });
    if (signal.aborted) {
      cancelQueued();
    }
    try {
      const operation = queue.add(
        async () => {
          signal.removeEventListener('abort', cancelQueued);
          if (signal.aborted) {
            throw cancelled();
          }
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), 60_000);
          const owner = AbortSignal.any([signal, deadline.signal]);
          try {
            const result = await action(owner);
            if (owner.aborted) {
              throw cancelled();
            }
            return result;
          } catch (error) {
            if (deadline.signal.aborted && !signal.aborted) {
              throw new YouTubeError('TIMEOUT', 'YouTube job timed out.');
            }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
        { signal: queued.signal, priority, throwOnTimeout: true },
      );
      return await Promise.race([operation, cancellation]);
    } catch (error) {
      if (signal.aborted) {
        throw cancelled();
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancelQueued);
    }
  }

  private executable(): string {
    return youtubeExecutable();
  }

  private async version(signal: AbortSignal): Promise<string> {
    const version = (
      await runYouTubeProcess(
        this.executable(),
        [
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-remote-components',
          '--version',
        ],
        signal,
        5000,
        4096,
      )
    ).trim();
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(version)) {
      throw new YouTubeError(
        'VERSION_MISMATCH',
        `Provision yt-dlp ${ExtractorVersion}; the installed version is unsupported.`,
      );
    }
    return version;
  }

  private assertVersion(version: string): void {
    if (version !== ExtractorVersion) {
      throw new YouTubeError(
        'VERSION_MISMATCH',
        `Provision yt-dlp ${ExtractorVersion}; the installed version does not match the tested pin.`,
      );
    }
  }

  private async runtime(signal: AbortSignal): Promise<string> {
    const executable =
      process.env.TUNARR_YOUTUBE_JS_RUNTIME_PATH || process.execPath;
    let version: string;
    try {
      version = (
        await runYouTubeProcess(executable, ['--version'], signal, 5000, 4096)
      ).trim();
    } catch (error) {
      if (
        error instanceof YouTubeError &&
        ['CANCELLED', 'TIMEOUT', 'OUTPUT_LIMIT'].includes(error.code)
      ) {
        throw error;
      }
      throw new YouTubeError(
        'RUNTIME_UNAVAILABLE',
        'Configured YouTube Node runtime could not start.',
      );
    }
    const match = /^v(\d+)\.\d+\.\d+$/.exec(version);
    if (!match || Number(match[1]) < 22) {
      throw new YouTubeError(
        'RUNTIME_UNAVAILABLE',
        'YouTube requires a supported Node >=22 runtime.',
      );
    }
    return executable;
  }

  private extractorArguments(runtime: string): string[] {
    return [
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-remote-components',
      '--no-js-runtimes',
      '--js-runtimes',
      `node:${runtime}`,
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-cache-dir',
      '--proxy',
      '',
      '--skip-download',
      '--dump-single-json',
      '--no-progress',
      '--retries',
      '0',
      '--extractor-retries',
      '0',
      '--socket-timeout',
      '10',
    ];
  }

  private async extract(
    videoId: string,
    signal: AbortSignal,
  ): Promise<ExtractedVideo> {
    this.assertVersion(await this.version(signal));
    const runtime = await this.runtime(signal);
    const json = await runYouTubeProcess(
      this.executable(),
      [
        ...this.extractorArguments(runtime),
        '--no-playlist',
        '--',
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      signal,
      30_000,
      MaxOutputBytes,
    );
    return parseVideo(json, videoId);
  }
}
