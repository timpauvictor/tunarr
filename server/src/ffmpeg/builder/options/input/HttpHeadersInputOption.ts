import type { MediaStream } from '@/ffmpeg/builder/MediaStream.js';
import type { InputSource } from '@/ffmpeg/builder/input/InputSource.js';
import { isEmpty } from 'lodash-es';
import { InputOption } from './InputOption.ts';

export class HttpHeadersInputOption extends InputOption {
  appliesToInput(input: InputSource<MediaStream>): boolean {
    return input.source.type === 'http' && !isEmpty(input.source.extraHeaders);
  }

  options(inputSource: InputSource<MediaStream>): string[] {
    if (inputSource.source.type !== 'http') {
      return [];
    }
    const headers = Object.entries(inputSource.source.extraHeaders);
    for (const [name, value] of headers) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new Error('Invalid media input header.');
      }
    }
    // spawn receives arguments directly, not through a shell. Literal quotes
    // become part of the header name, and repeated -headers lose earlier ones.
    return headers.length > 0
      ? [
          '-headers',
          headers.map(([name, value]) => `${name}: ${value}\r\n`).join(''),
        ]
      : [];
  }
}
