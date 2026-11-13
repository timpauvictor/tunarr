import { beforeEach, expect, test, vi } from 'vitest';
import type * as Sdk from '../../../generated/sdk.gen.ts';
import { act, renderWithProviders, screen } from '../../../test/utils.tsx';
import { YouTubeMediaSourceDialog } from './YouTubeMediaSourceDialog.tsx';

const boundary = vi.hoisted(() => ({
  health: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../generated/sdk.gen.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  getYouTubeHealth: boundary.health,
}));
vi.mock('../../../hooks/media-sources/mediaSourceHooks.ts', () => ({
  useCreateMediaSource: () => ({
    mutate: boundary.create,
    isPending: false,
    isError: false,
  }),
  useUpdateMediaSource: () => ({
    mutate: boundary.update,
    isPending: false,
    isError: false,
  }),
}));
beforeEach(() => {
  vi.resetAllMocks();
});

test('setup failure retries, reports the tool version without claiming playback, and keeps the source name', async () => {
  boundary.health
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      data: {
        available: true,
        extractorVersion: '2026.10.26',
        message: 'internal diagnostic',
      },
    });
  const { user } = renderWithProviders(
    <YouTubeMediaSourceDialog open onClose={vi.fn()} />,
  );
  await user.clear(screen.getByRole('textbox', { name: 'Name' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'My videos');
  await user.click(screen.getByRole('button', { name: 'Test setup' }));
  await screen.findByText(
    'Could not test setup. Check the server connection and retry.',
  );
  await user.click(screen.getByRole('button', { name: 'Test setup' }));
  await screen.findByText(
    'YouTube extractor and Node runtime are ready. Playback has not been verified.',
  );
  expect(screen.getByText('yt-dlp version: 2026.10.26')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(
    'My videos',
  );
  expect(boundary.health).toHaveBeenCalledTimes(2);
  expect(boundary.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(boundary.create).toHaveBeenCalledWith(
    expect.objectContaining({
      body: { name: 'My videos', type: 'youtube', pathReplacements: [] },
    }),
    expect.anything(),
  );
});

test('closing aborts a pending health request and ignores its late response', async () => {
  let finish: (value: {
    data: { available: boolean; message: string };
  }) => void = () => {
    throw new Error('Request was not started');
  };
  boundary.health.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { user, rerender } = renderWithProviders(
    <YouTubeMediaSourceDialog open onClose={vi.fn()} />,
  );
  await user.click(screen.getByRole('button', { name: 'Test setup' }));
  expect(
    screen.getByRole('progressbar', { name: 'Testing YouTube setup' }),
  ).toBeInTheDocument();
  const signal: AbortSignal = boundary.health.mock.calls[0][0].signal;
  rerender(<YouTubeMediaSourceDialog open={false} onClose={vi.fn()} />);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish({ data: { available: true, message: 'Late result' } });
  });
  expect(screen.queryByText('Late result')).not.toBeInTheDocument();
  expect(boundary.create).not.toHaveBeenCalled();
});

test('missing tools show localized recovery plus diagnostic detail, not a playback failure', async () => {
  boundary.health.mockResolvedValue({
    data: { available: false, message: 'YouTube tool could not start.' },
  });
  const { user } = renderWithProviders(
    <YouTubeMediaSourceDialog open onClose={vi.fn()} />,
  );
  await user.click(screen.getByRole('button', { name: 'Test setup' }));
  await screen.findByText(
    /YouTube tools are unavailable\. Reinstall the companions/,
  );
  expect(screen.getByText('YouTube tool could not start.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test setup' })).toBeEnabled();
});
