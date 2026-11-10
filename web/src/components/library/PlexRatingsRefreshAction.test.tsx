import { AxiosHeaders } from 'axios';
import type { PlexRatingsRefreshStatus } from '@tunarr/types/schemas';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as GeneratedSdk from '../../generated/sdk.gen.ts';
import {
  getApiMediaSourcesByIdLibrariesByLibraryIdRatings,
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel,
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
} from '../../generated/sdk.gen.ts';
import {
  renderWithProviders,
  screen,
  seededQueryClient,
} from '../../test/utils.tsx';
import { PlexRatingsRefreshAction } from './PlexRatingsRefreshAction.tsx';

vi.mock('../../generated/sdk.gen.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof GeneratedSdk>()),
  getApiMediaSourcesByIdLibrariesByLibraryIdRatings: vi.fn(),
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh: vi.fn(),
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel: vi.fn(),
}));
const mediaSourceId = '00000000-0000-4000-8000-000000000001';
const libraryId = '00000000-0000-4000-8000-000000000002';
const job: PlexRatingsRefreshStatus = {
  jobId: '00000000-0000-4000-8000-000000000003',
  mediaSourceId,
  libraryId,
  state: 'in_progress',
  cancelRequested: false,
  total: 2,
  processed: 0,
  refreshed: 0,
  unchanged: 0,
  failed: 0,
  skipped: 0,
  indexFailed: 0,
  startedAt: 1,
  finishedAt: null,
  lastError: null,
};
const response = <T,>(data: T) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: new AxiosHeaders(),
  config: { headers: new AxiosHeaders() },
  error: undefined,
});
let current: PlexRatingsRefreshStatus | null;
beforeEach(() => {
  vi.clearAllMocks();
  current = null;
  vi.mocked(
    getApiMediaSourcesByIdLibrariesByLibraryIdRatings,
  ).mockImplementation(async () => response(current));
  vi.mocked(
    postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
  ).mockImplementation(async () => {
    current = { ...job };
    return response(current);
  });
  vi.mocked(
    postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel,
  ).mockImplementation(async () => {
    current = {
      ...job,
      state: 'cancelled',
      cancelRequested: true,
      finishedAt: 2,
    };
    return response(undefined);
  });
});

describe('Plex ratings refresh action', () => {
  test('starts only on request, survives dialog close and cancels the admitted job while the library is locked', async () => {
    const { user, rerender } = renderWithProviders(
      <PlexRatingsRefreshAction
        mediaSourceId={mediaSourceId}
        libraryId={libraryId}
      />,
      { queryClient: seededQueryClient([]) },
    );
    expect(
      getApiMediaSourcesByIdLibrariesByLibraryIdRatings,
    ).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Plex ratings' }));
    await screen.findByText(
      'No ratings-only job has run in this server session.',
    );
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
    ).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Refresh ratings only' }),
    );
    await screen.findByText('Refreshing ratings');
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
    ).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel,
    ).not.toHaveBeenCalled();
    rerender(
      <PlexRatingsRefreshAction
        mediaSourceId={mediaSourceId}
        libraryId={libraryId}
        busy
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Plex ratings' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Cancel refresh' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Refresh ratings only' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel refresh' }));
    await screen.findByText('Cancelled');
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: mediaSourceId, libraryId, jobId: job.jobId },
        throwOnError: true,
      }),
    );
  });

  test('never enables an unavailable library as a side effect of the action', async () => {
    const { user } = renderWithProviders(
      <PlexRatingsRefreshAction
        mediaSourceId={mediaSourceId}
        libraryId={libraryId}
        disabled
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Plex ratings' }));
    await screen.findByText(
      'No ratings-only job has run in this server session.',
    );
    expect(
      screen.getByRole('button', { name: 'Refresh ratings only' }),
    ).toBeDisabled();
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
    ).not.toHaveBeenCalled();
  });

  test('checks server status after an uncertain accepted write instead of retrying the POST', async () => {
    vi.mocked(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
    ).mockImplementationOnce(async () => {
      current = { ...job };
      throw new Error('Fixture response lost after acceptance');
    });
    const { user } = renderWithProviders(
      <PlexRatingsRefreshAction
        mediaSourceId={mediaSourceId}
        libraryId={libraryId}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Plex ratings' }));
    await screen.findByText(
      'No ratings-only job has run in this server session.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Refresh ratings only' }),
    );
    await screen.findByText('Refreshing ratings');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Refresh ratings only' }),
      ).toBeDisabled(),
    );
    expect(
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
    ).toHaveBeenCalledTimes(1);
    expect(
      getApiMediaSourcesByIdLibrariesByLibraryIdRatings,
    ).toHaveBeenCalledTimes(2);
  });
});
