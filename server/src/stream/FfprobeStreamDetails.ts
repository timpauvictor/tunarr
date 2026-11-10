import { FfmpegInfo } from '@/ffmpeg/ffmpegInfo.js';
import type {
  FfprobeAudioStream,
  FfprobeSubtitleStream,
  FfprobeVideoStream,
} from '@/types/ffmpeg.js';
import dayjs from '@/util/dayjs.js';
import {
  isNonEmptyArray,
  isNonEmptyString,
  parseFloatOrNull,
} from '@/util/index.js';
import { seq } from '@tunarr/shared/util';
import type { MediaChapter } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { filter, find, isEmpty, isNull, map, orderBy } from 'lodash-es';
import type { NonEmptyArray } from 'ts-essentials';
import { LanguageService } from '../services/LanguageService.ts';
import { Result } from '../types/result.ts';
import type { StreamDetailsFetcher } from './ExternalStreamDetailsFetcher.ts';
import type {
  AudioStreamDetails,
  ProgramStreamResult,
  SubtitleStreamDetails,
  VideoStreamDetails,
} from './types.ts';
import { FileStreamSource, HttpStreamSource } from './types.ts';

export function videoStreamDetailsFromProbe(
  video: FfprobeVideoStream,
): VideoStreamDetails {
  const displayAspectRatio =
    video.display_aspect_ratio ?? `${video.coded_width / video.coded_height}`;
  return {
    sampleAspectRatio: isNonEmptyString(video.sample_aspect_ratio)
      ? video.sample_aspect_ratio
      : '1:1',
    scanType:
      video.field_order === 'interlaced'
        ? 'interlaced'
        : video.field_order === 'progressive'
          ? 'progressive'
          : 'unknown',
    width: video.width,
    height: video.height,
    framerate: video.r_frame_rate ?? undefined,
    displayAspectRatio,
    anamorphic: extractIsAnamorphic(
      video.width,
      video.height,
      displayAspectRatio,
    ),
    pixelFormat: video.pix_fmt,
    bitDepth: video.bits_per_raw_sample,
    bitrate: video.bit_rate,
    codec: video.codec_name,
    profile: video.profile?.toLowerCase(),
    streamIndex: video.index,
    colorPrimaries: video.color_primaries,
    colorRange: video.color_range,
    colorSpace: video.color_space,
    colorTransfer: video.color_transfer,
    isAttachedPic: false,
  };
}

export function audioStreamDetailsFromProbe(
  audioStream: FfprobeAudioStream,
): AudioStreamDetails {
  const lang = audioStream.tags?.['language'];
  return {
    bitrate: audioStream.bit_rate ?? undefined,
    channels: audioStream.channels,
    codec: audioStream.codec_name,
    index: audioStream.index,
    default: audioStream.disposition?.default === 1,
    language:
      lang && LanguageService.isValidLanguageCode(lang) ? lang : undefined,
    languageCodeISO6392: lang
      ? LanguageService.getAlpha3TCode(lang)
      : undefined,
    profile: audioStream.profile,
    title: audioStream.tags?.['title'],
  } satisfies AudioStreamDetails;
}

/**
 * Converts ffprobe seconds to whole milliseconds, rounding down.
 *
 * ffprobe prints microsecond precision, so snapping to microseconds first
 * strips float noise (8.021 * 1000 is 8021.000000000001) before the floor.
 */
export function secondsToWholeMs(seconds: number): number {
  return Math.floor(Math.round(seconds * 1_000_000) / 1_000);
}

type FfprobeStreamDetailsRequest = {
  path: string;
};

@injectable()
export class FfprobeStreamDetails
  implements StreamDetailsFetcher<FfprobeStreamDetailsRequest>
{
  constructor(@inject(FfmpegInfo) private ffmpegInfo: FfmpegInfo) {}

  async getStream({
    path,
  }: FfprobeStreamDetailsRequest): Promise<Result<ProgramStreamResult>> {
    const probeResult = await Result.attemptAsync(() =>
      this.ffmpegInfo.probeFile(path),
    );

    if (probeResult.isFailure()) {
      return probeResult.recast();
    }

    const probeDetails = probeResult.get();
    if (!probeDetails) {
      return Result.failure(
        `ffprobe output for ${path} did not match the expected schema`,
      );
    }

    const videoStream = find(
      probeDetails.streams,
      (stream): stream is FfprobeVideoStream => stream.codec_type === 'video',
    );

    const videoDetails = videoStream
      ? videoStreamDetailsFromProbe(videoStream)
      : undefined;

    const audioStreamDetails = map(
      filter(
        probeDetails.streams,
        (stream): stream is FfprobeAudioStream => stream.codec_type === 'audio',
      ),
      audioStreamDetailsFromProbe,
    );

    const subtitleStreamDetails = map(
      filter(
        probeDetails.streams,
        (stream): stream is FfprobeSubtitleStream =>
          stream.codec_type === 'subtitle',
      ),
      (stream) => {
        const lang = stream.tags?.['language'];
        const validLang =
          lang && LanguageService.isValidLanguageCode(lang) ? lang : undefined;
        return {
          type: 'embedded',
          codec: stream.codec_name ?? 'unknown',
          index: stream.index,
          default: stream.disposition?.default === 1,
          forced: stream.disposition?.forced === 1,
          sdh: stream.disposition?.hearing_impaired === 1,
          language: validLang,
          languageCodeISO6392: validLang
            ? LanguageService.getAlpha3TCode(validLang)
            : undefined,
        } satisfies SubtitleStreamDetails;
      },
    );

    return Result.success({
      streamDetails: {
        videoDetails: videoDetails ? [videoDetails] : undefined,
        audioDetails: isEmpty(audioStreamDetails)
          ? undefined
          : (audioStreamDetails as NonEmptyArray<AudioStreamDetails>),
        subtitleDetails: isNonEmptyArray(subtitleStreamDetails)
          ? subtitleStreamDetails
          : undefined,
        duration: dayjs.duration(
          secondsToWholeMs(probeDetails.format.duration),
        ),
        formatTags: probeDetails.format.tags,
        chapters: seq.collect(
          orderBy(probeDetails.chapters, (c) => c.start, 'asc'),
          (chapter, index) => {
            const startSeconds = parseFloatOrNull(chapter.start_time);
            const endSeconds = parseFloatOrNull(chapter.end_time);
            if (isNull(startSeconds) || isNull(endSeconds)) {
              return;
            }

            return {
              chapterType: 'chapter',
              index,
              startTime: secondsToWholeMs(startSeconds),
              endTime: secondsToWholeMs(endSeconds),
              title: chapter?.tags?.['title'],
            } satisfies MediaChapter;
          },
        ),
      },
      inputs: [
        {
          id: 'main',
          source: path.startsWith('http')
            ? new HttpStreamSource(path)
            : new FileStreamSource(path),
        },
      ],
    });
  }
}

function extractIsAnamorphic(
  width: number,
  height: number,
  aspectRatioString: string,
) {
  const resolutionRatio = width / height;
  const [numS, denS] = aspectRatioString.split(':');
  const num = parseFloat(numS!);
  const den = parseFloat(denS!);
  if (isNaN(num) || isNaN(den)) {
    return false;
  }

  return Math.abs(resolutionRatio - num / den) > 0.01;
}
