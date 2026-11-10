import { inject, injectable } from 'inversify';
import dayjs from 'dayjs';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import {
  YouTubeAdapter,
  YouTubeError,
} from '../external/youtube/YouTubeAdapter.ts';
import { KEYS } from '../types/inject.ts';
import { makeLocalUrl } from '../util/serverUtil.ts';
import {
  YouTubeMediaRelay,
  validateYouTubeMediaHeaders,
  validateYouTubeMediaUrl,
} from './YouTubeMediaRelay.ts';
import {
  audioStreamDetailsFromProbe,
  videoStreamDetailsFromProbe,
} from './FfprobeStreamDetails.ts';
import type { MediaInput } from './MediaInputs.ts';
import type {
  AudioStreamDetails,
  ProgramStreamResult,
  VideoStreamDetails,
} from './types.ts';

@injectable()
export class YouTubePlaybackResolver {
  constructor(
    @inject(YouTubeAdapter)
    private adapter: Pick<YouTubeAdapter, 'resolve' | 'probe'>,
    @inject(YouTubeMediaRelay) private relay: YouTubeMediaRelay,
    @inject(KEYS.SettingsDB) private settings: ISettingsDB,
  ) {}

  async resolve(
    videoId: string,
    signal: AbortSignal,
    maxHeight: number,
    expiresAt?: number,
  ): Promise<ProgramStreamResult> {
    signal.throwIfAborted();
    const owner = new AbortController();
    const abort = () => owner.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    const releaseInputs: Array<() => void> = [];
    const expiry =
      expiresAt === undefined
        ? undefined
        : setTimeout(abort, Math.max(0, expiresAt - Date.now()));
    expiry?.unref();
    const cleanup = () => {
      clearTimeout(expiry);
      signal.removeEventListener('abort', abort);
      for (const release of releaseInputs) {
        release();
      }
    };
    owner.signal.addEventListener('abort', cleanup, { once: true });
    try {
      if (expiresAt !== undefined && expiresAt <= Date.now()) owner.abort();
      owner.signal.throwIfAborted();
      const resolved = await this.adapter.resolve(
        videoId,
        maxHeight,
        owner.signal,
      );
      owner.signal.throwIfAborted();
      const base = new URL(makeLocalUrl('/'));
      if (base.hostname === 'localhost') {
        base.hostname = '127.0.0.1';
      }
      const inputs: MediaInput[] = [];
      const videos: VideoStreamDetails[] = [];
      const audios: AudioStreamDetails[] = [];
      const leases = new Map<
        string,
        ReturnType<YouTubeMediaRelay['register']>
      >();
      let generation = 0;
      let renewal: Promise<void> | undefined;
      // One owning attempt renews its whole captured input set once. This is
      // never shared across playback attempts/sessions and dies with the owner.
      const refresh = async (
        failedGeneration: number,
        canRenew: boolean,
      ): Promise<boolean> => {
        if (!canRenew) {
          owner.abort();
          return false;
        }
        if (failedGeneration < generation) {
          return true;
        }
        if (generation > 0) {
          owner.abort();
          return false;
        }
        renewal ??= (async () => {
          const fresh = await this.adapter.resolve(
            videoId,
            maxHeight,
            owner.signal,
          );
          if (
            fresh.durationSeconds !== resolved.durationSeconds ||
            fresh.inputs.length !== leases.size ||
            new Set(fresh.inputs.map((input) => input.id)).size !==
              leases.size ||
            fresh.inputs.some((input) => !leases.has(input.id))
          ) {
            throw new YouTubeError(
              'NO_PLAYABLE_FORMAT',
              'YouTube changed the selected media during playback.',
            );
          }
          const prepared = fresh.inputs.map((input) => ({
            ...input,
            url: validateYouTubeMediaUrl(input.url).href,
            headers: validateYouTubeMediaHeaders(input.headers),
          }));
          owner.signal.throwIfAborted();
          for (const input of prepared) {
            leases.get(input.id)?.replace(input);
          }
          generation++;
        })();
        try {
          await renewal;
          return true;
        } catch {
          owner.abort();
          return false;
        }
      };
      for (const input of resolved.inputs) {
        owner.signal.throwIfAborted();
        const lease = this.relay.register({
          ...input,
          signal: owner.signal,
          baseUrl: base.href,
          refresh,
        });
        releaseInputs.push(lease.release);
        leases.set(input.id, lease);
        inputs.push({ id: input.id, source: lease.source });
      }
      for (const [inputId, lease] of leases) {
        const probe = await this.adapter.probe(
          lease.source,
          this.settings.ffmpegSettings().ffprobeExecutablePath,
          owner.signal,
        );
        owner.signal.throwIfAborted();
        for (const track of probe.streams) {
          if (track.codec_type === 'video') {
            videos.push({ ...videoStreamDetailsFromProbe(track), inputId });
          } else if (track.codec_type === 'audio') {
            audios.push({ ...audioStreamDetailsFromProbe(track), inputId });
          }
        }
      }
      const [firstInput, ...otherInputs] = inputs;
      const [firstVideo, ...otherVideos] = videos;
      if (!firstInput || !firstVideo) {
        throw new YouTubeError(
          'NO_PLAYABLE_FORMAT',
          'Selected YouTube inputs have no usable video track.',
        );
      }
      const [firstAudio, ...otherAudios] = audios;
      return {
        inputs: [firstInput, ...otherInputs],
        streamDetails: {
          duration: dayjs.duration(resolved.durationSeconds, 'seconds'),
          videoDetails: [firstVideo, ...otherVideos],
          audioDetails: firstAudio ? [firstAudio, ...otherAudios] : undefined,
        },
      };
    } catch (error) {
      owner.abort();
      cleanup();
      throw error;
    }
  }
}
