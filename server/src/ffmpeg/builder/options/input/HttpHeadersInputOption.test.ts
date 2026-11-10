import { expect, test } from 'vitest';
import { HttpStreamSource } from '../../../../stream/types.ts';
import { AudioInputSource } from '../../input/AudioInputSource.ts';
import { AudioStream } from '../../MediaStream.ts';
import { AudioState } from '../../state/AudioState.ts';
import { HttpHeadersInputOption } from './HttpHeadersInputOption.ts';

function input(headers: Record<string, string>) {
  return AudioInputSource.withStream(
    new HttpStreamSource('https://fixture.example/audio', headers),
    AudioStream.create({ index: 0, channels: 2, codec: 'aac' }),
    AudioState.create({
      audioEncoder: 'aac',
      audioChannels: 2,
      audioBitrate: 128,
      audioBufferSize: 256,
    }),
  );
}

test('keeps all per-input headers in one raw CRLF-delimited spawn argument', () => {
  expect(
    new HttpHeadersInputOption().options(
      input({
        Authorization: 'Bearer fixture-key',
        'User-Agent': 'fixture-agent',
      }),
    ),
  ).toEqual([
    '-headers',
    'Authorization: Bearer fixture-key\r\nUser-Agent: fixture-agent\r\n',
  ]);
  expect(new HttpHeadersInputOption().options(input({}))).toEqual([]);
});

test('rejects header line injection', () => {
  expect(() =>
    input({
      Authorization: 'Bearer fixture\r\nInjected: value',
    }).getInputOptions(),
  ).toThrow('Invalid media input header');
});
