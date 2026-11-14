import { act, renderWithProviders, screen, waitFor } from '@/test/utils.tsx';
import type { TroubleshootResult } from '@tunarr/types/schemas';
import type * as HlsModule from 'hls.js';
import { beforeEach, expect, test, vi } from 'vitest';
import { hlsFixture, latestHlsPlayer } from '../../test/hlsFixture.ts';
import { makeMovie } from '../../test/programFixtures.ts';
import { TroubleshootPage } from './TroubleshootPage.tsx';

const boundary = vi.hoisted(() => ({
  run: vi.fn<(request: unknown) => Promise<{ data: TroubleshootResult }>>(),
}));
vi.mock('hls.js', async (importOriginal) => {
  const original = await importOriginal<typeof HlsModule>();
  const { createHlsFixture } = await import('../../test/hlsFixture.ts');
  return { ...original, default: createHlsFixture(original.default) };
});
vi.mock('../../store/settings/selectors.ts', () => ({
  useSettings: () => ({ backendUri: 'http://tunarr.test' }),
}));
vi.mock('../../components/ProgramSearchAutocomplete.tsx', () => ({
  ProgramSearchAutocomplete: () => null,
}));
vi.mock('../../generated/index.ts', () => ({
  postApiTroubleshoot: boundary.run,
}));
vi.mock('../../generated/@tanstack/react-query.gen.ts', () => ({
  getChannelsOptions: () => ({
    queryKey: ['channels'],
    queryFn: () => [{ id: 'channel-a', name: 'Fixture', number: 3 }],
  }),
  getApiTranscodeConfigsOptions: () => ({
    queryKey: ['transcode-configs'],
    queryFn: () => [],
  }),
  getApiEtvChannelsByIdDiagnosticsOptions: () => ({
    queryKey: ['diagnostics'],
    queryFn: () => ({ dossiers: [] }),
  }),
}));

const report: TroubleshootResult = {
  systemInfo: {
    tunarrVersion: 'fixture',
    ffmpegVersion: 'fixture',
    nodeVersion: '22',
    platform: 'linux',
    arch: 'x64',
    availableHwAccels: [],
  },
  errors: [],
  timestamp: '2026-11-13T00:00:00Z',
  testTranscode: {
    success: true,
    hlsSessionId: 'session-a',
    exitCode: 0,
    signal: null,
    stderrOutput: '',
  },
};

beforeEach(() => {
  hlsFixture.players.length = 0;
  hlsFixture.supported = true;
  boundary.run.mockReset().mockResolvedValue({ data: report });
});

test('Run starts the diagnostic player, Retry reuses its session, and rerun/unmount release owners', async () => {
  const { user, unmount, container } = renderWithProviders(
    <TroubleshootPage
      initialProgram={makeMovie()}
      initialChannelId="channel-a"
    />,
  );
  expect(hlsFixture.players).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Run Troubleshooter' }));
  await waitFor(() => expect(hlsFixture.players).toHaveLength(1));
  const first = latestHlsPlayer();
  expect(first.config.startPosition).toBe(0);
  expect(first.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/api/troubleshoot/stream/session-a/live.m3u8',
  );
  expect(first.attachMedia).toHaveBeenCalledExactlyOnceWith(
    container.querySelector('video'),
  );
  act(() => {
    first.emitError({
      fatal: true,
      url: 'https://private.invalid/?token=secret',
    });
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Stream playback failed');
  expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
  expect(first.destroy).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Retry playback' }));
  const retry = latestHlsPlayer();
  expect(retry.loadSource).toHaveBeenCalledExactlyOnceWith(
    'http://tunarr.test/api/troubleshoot/stream/session-a/live.m3u8',
  );
  expect(boundary.run).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  boundary.run.mockResolvedValue({
    data: {
      ...report,
      testTranscode: {
        ...report.testTranscode,
        success: true,
        exitCode: 0,
        signal: null,
        stderrOutput: '',
        hlsSessionId: 'session-b',
      },
    },
  });
  await user.click(screen.getByRole('button', { name: 'Run Troubleshooter' }));
  await waitFor(() =>
    expect(latestHlsPlayer().loadSource).toHaveBeenCalledWith(
      'http://tunarr.test/api/troubleshoot/stream/session-b/live.m3u8',
    ),
  );
  expect(retry.destroy).toHaveBeenCalledOnce();
  const current = latestHlsPlayer();
  unmount();
  expect(current.destroy).toHaveBeenCalledOnce();
});

test('a diagnostic response arriving after leaving cannot acquire a player', async () => {
  let finish: ((response: { data: TroubleshootResult }) => void) | undefined;
  boundary.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { user, unmount } = renderWithProviders(
    <TroubleshootPage
      initialProgram={makeMovie()}
      initialChannelId="channel-a"
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Run Troubleshooter' }));
  expect(boundary.run).toHaveBeenCalledOnce();
  unmount();
  await act(async () => {
    if (!finish) throw new Error('Expected a pending diagnostic request.');
    finish({ data: report });
  });
  expect(hlsFixture.players).toHaveLength(0);
});
