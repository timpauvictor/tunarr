import { act, renderWithProviders, screen } from '@/test/utils.tsx';
import type * as HlsModule from 'hls.js';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hlsFixture, latestHlsPlayer } from '../test/hlsFixture.ts';
import Video from './Video.tsx';

const boundary = vi.hoisted(() => ({
  noAutoPlay: false,
  audioFormat: 'aac',
  configReady: true,
}));

vi.mock('hls.js', async (importOriginal) => {
  const original = await importOriginal<typeof HlsModule>();
  const { createHlsFixture } = await import('../test/hlsFixture.ts');
  return { ...original, default: createHlsFixture(original.default) };
});
vi.mock('@/routes/channels_/$channelId/watch.tsx', () => ({
  Route: { useSearch: () => ({ noAutoPlay: boundary.noAutoPlay }) },
}));
vi.mock('../hooks/settingsHooks.ts', () => ({
  useChannelTranscodeConfig: () => ({
    data: boundary.configReady
      ? { audioFormat: boundary.audioFormat }
      : undefined,
  }),
}));
vi.mock('../store/settings/selectors.ts', () => ({
  useSettings: () => ({ backendUri: 'http://tunarr.test' }),
}));

beforeEach(() => {
  hlsFixture.players.length = 0;
  hlsFixture.supported = true;
  boundary.noAutoPlay = false;
  boundary.audioFormat = 'aac';
  boundary.configReady = true;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

test('Watch loads the channel, replaces it on Reload and releases it on exit', async () => {
  const { user, unmount, container } = renderWithProviders(
    <Video channelId="channel-a" />,
  );
  const first = latestHlsPlayer();
  expect(first.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-a.m3u8',
  );
  expect(first.attachMedia).toHaveBeenCalledExactlyOnceWith(
    container.querySelector('video'),
  );
  await user.click(screen.getByRole('button', { name: 'Reload Stream' }));
  const replacement = latestHlsPlayer();
  expect(replacement).not.toBe(first);
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(replacement.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-a.m3u8',
  );
  unmount();
  expect(replacement.destroy).toHaveBeenCalledOnce();
});

test('waits for the channel profile and keeps its player through unrelated rerenders', () => {
  boundary.configReady = false;
  const { rerender } = renderWithProviders(<Video channelId="channel-a" />);
  expect(hlsFixture.players).toHaveLength(0);
  boundary.configReady = true;
  rerender(<Video channelId="channel-a" />);
  const player = latestHlsPlayer();
  expect(player.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-a.m3u8',
  );
  rerender(<Video channelId="channel-a" />);
  expect(hlsFixture.players).toHaveLength(1);
  expect(player.destroy).not.toHaveBeenCalled();
});

test('manual mode makes no media request until Load and does not carry intent to another channel', async () => {
  boundary.noAutoPlay = true;
  const { user, rerender, container } = renderWithProviders(
    <Video channelId="channel-a" />,
  );
  expect(
    hlsFixture.players.every((p) => p.loadSource.mock.calls.length === 0),
  ).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Load Stream' }));
  const first = latestHlsPlayer();
  expect(first.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-a.m3u8',
  );
  expect(first.attachMedia).toHaveBeenCalledExactlyOnceWith(
    container.querySelector('video'),
  );
  rerender(<Video channelId="channel-b" />);
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(
    hlsFixture.players.every((p) =>
      p.loadSource.mock.calls.every(([url]) => !url.includes('channel-b')),
    ),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Load Stream' })).toBeEnabled();
  rerender(<Video channelId="channel-a" />);
  expect(
    hlsFixture.players.filter((p) => p.loadSource.mock.calls.length > 0),
  ).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Load Stream' }));
  expect(latestHlsPlayer().loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-a.m3u8',
  );
});

test('fatal playback errors are visible and safe, with no restart until explicit Reload', async () => {
  const { user } = renderWithProviders(<Video channelId="channel-a" />);
  const first = latestHlsPlayer();
  act(() => {
    first.emitError({
      fatal: true,
      url: 'https://private.invalid/?token=secret',
    });
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Stream playback failed');
  expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(hlsFixture.players).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Reload Stream' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(latestHlsPlayer().loadSource).toHaveBeenCalledOnce();
});

test('autoplay switches channels without stale loads and Strict Mode releases every owner', () => {
  const { rerender, unmount } = renderWithProviders(
    <StrictMode>
      <Video channelId="channel-a" />
    </StrictMode>,
  );
  rerender(
    <StrictMode>
      <Video channelId="channel-b" />
    </StrictMode>,
  );
  expect(latestHlsPlayer().loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/stream/channels/channel-b.m3u8',
  );
  unmount();
  for (const player of hlsFixture.players)
    expect(player.destroy).toHaveBeenCalledOnce();
});

test.each(['unsupported browser', 'AC3 profile'])(
  'does not start media for %s',
  (condition) => {
    hlsFixture.supported = condition !== 'unsupported browser';
    boundary.audioFormat = condition === 'AC3 profile' ? 'ac3' : 'aac';
    renderWithProviders(<Video channelId="channel-a" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      hlsFixture.players.every((p) => p.loadSource.mock.calls.length === 0),
    ).toBe(true);
  },
);
