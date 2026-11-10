import type { ContentProgram, MediaSourceSettings } from '@tunarr/types';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProgrammingSelectionContextType } from '../../context/ProgrammingSelectionContext.ts';
import type * as Sdk from '../../generated/sdk.gen.ts';
import { Imported } from '../../helpers/constants.ts';
import { makeContentProgram, makeMovie } from '../../test/programFixtures.ts';
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
} from '../../test/utils.tsx';
import type { AddedMedia } from '../../types/index.ts';
import { YouTubeImportDialog } from './YouTubeImportDialog.tsx';

const boundary = vi.hoisted(() => ({
  importVideo: vi.fn(),
  pathname: '/channels/channel-1/programming/add',
}));

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: boundary.pathname }),
}));
vi.mock('../../generated/sdk.gen.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  importYouTubeVideo: boundary.importVideo,
}));

const source = {
  id: 'youtube-1',
  name: 'YouTube',
  type: 'youtube',
  libraries: [],
  pathReplacements: [],
} satisfies Extract<MediaSourceSettings, { type: 'youtube' }>;

const video = makeContentProgram(
  {
    ...makeMovie(),
    type: 'other_video',
    sourceType: 'youtube',
    uuid: '11111111-1111-4111-8111-111111111111',
    mediaSourceId: source.id,
    libraryId: 'saved-videos',
    canonicalId: 'youtube:abcdefghijk',
    externalId: 'abcdefghijk',
    title: 'A finite video',
    summary: 'Saved description',
    youtubeMetadata: { creatorName: 'Example creator', creatorId: 'creator-1' },
    duration: 125000,
  },
  125000,
);

function response(program: ContentProgram = video) {
  return { data: { sourceId: source.id, libraryId: 'saved-videos', program } };
}

function deferred() {
  let settle: (value: ReturnType<typeof response>) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<ReturnType<typeof response>>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value: ReturnType<typeof response>) => settle(value),
  };
}

function programmingTarget() {
  return {
    entityType: 'channel',
    onAddSelectedMedia: vi.fn(),
    onAddMediaSuccess: vi.fn(),
  } satisfies Pick<
    ProgrammingSelectionContextType,
    'entityType' | 'onAddSelectedMedia' | 'onAddMediaSuccess'
  >;
}

const url = 'https://www.youtube.com/watch?v=abcdefghijk';

describe('YouTubeImportDialog SDK boundary', () => {
  beforeEach(() => {
    boundary.importVideo.mockReset();
    boundary.pathname = '/channels/channel-1/programming/add';
  });

  test('reviews metadata, requires explicit Add, preserves a mixed draft and blocks duplicate Add after reimport', async () => {
    boundary.importVideo.mockResolvedValue(response());
    const draft: AddedMedia[] = [
      { type: Imported, media: makeContentProgram(makeMovie(), 60000) },
    ];
    const existing = draft[0];
    const target = programmingTarget();
    target.onAddSelectedMedia.mockImplementation((items: AddedMedia[]) =>
      draft.push(...items),
    );
    const { user } = renderWithProviders(
      <YouTubeImportDialog
        open
        source={source}
        onClose={vi.fn()}
        programming={target}
      />,
    );
    await user.type(screen.getByLabelText('YouTube video URL'), url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('A finite video')).toBeInTheDocument();
    expect(screen.getByText('Example creator')).toBeInTheDocument();
    expect(screen.getByText('Saved description')).toBeInTheDocument();
    expect(screen.getByText('Duration: 2 min 5 sec')).toBeInTheDocument();
    expect(screen.getByLabelText('No artwork available')).toBeInTheDocument();
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
    expect(draft).toEqual([existing]);
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    expect(target.onAddSelectedMedia).toHaveBeenCalledExactlyOnceWith([
      { type: Imported, media: video },
    ]);
    expect(target.onAddMediaSuccess).toHaveBeenCalledOnce();
    expect(draft).toEqual([existing, { type: Imported, media: video }]);
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();

    await user.clear(screen.getByLabelText('YouTube video URL'));
    await user.type(screen.getByLabelText('YouTube video URL'), url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('A finite video');
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    expect(target.onAddSelectedMedia).toHaveBeenCalledOnce();
  });

  test('cancels the exact signal, retains input and ignores an old completion while retry is pending', async () => {
    const old = deferred();
    const retry = deferred();
    boundary.importVideo
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(retry.promise);
    const target = programmingTarget();
    const { user } = renderWithProviders(
      <YouTubeImportDialog
        open
        source={source}
        onClose={vi.fn()}
        programming={target}
      />,
    );
    await user.type(screen.getByLabelText('YouTube video URL'), url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const signal: AbortSignal = boundary.importVideo.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByLabelText('YouTube video URL')).toHaveValue(url);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      old.resolve(response());
    });
    expect(screen.queryByText('A finite video')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('Importing video metadata'),
    ).toBeInTheDocument();
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
    await act(async () => {
      retry.resolve(response());
    });
    await screen.findByText('A finite video');
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    expect(target.onAddSelectedMedia).toHaveBeenCalledOnce();
  });

  test.each(['close', 'navigation', 'source', 'entity'] as const)(
    'invalidates pending review after %s and never appends a late response',
    async (change) => {
      const pending = deferred();
      boundary.importVideo.mockReturnValue(pending.promise);
      const target = programmingTarget();
      const onClose = vi.fn();
      const props = { open: true, source, onClose, programming: target };
      const { user, rerender } = renderWithProviders(
        <YouTubeImportDialog {...props} />,
      );
      await user.type(screen.getByLabelText('YouTube video URL'), url);
      await user.click(screen.getByRole('button', { name: 'Import' }));
      const signal: AbortSignal = boundary.importVideo.mock.calls[0][0].signal;
      if (change === 'close') {
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledOnce();
        rerender(<YouTubeImportDialog {...props} open={false} />);
      } else if (change === 'navigation') {
        boundary.pathname = '/channels/channel-2/programming/add';
        rerender(<YouTubeImportDialog {...props} />);
      } else if (change === 'source') {
        rerender(
          <YouTubeImportDialog
            {...props}
            source={{ ...source, id: 'youtube-2' }}
          />,
        );
      } else {
        rerender(
          <YouTubeImportDialog
            {...props}
            programming={{ ...target, entityType: 'filler-list' }}
          />,
        );
      }
      await waitFor(() => expect(signal.aborted).toBe(true));
      await act(async () => {
        pending.resolve(response());
      });
      expect(screen.queryByText('A finite video')).not.toBeInTheDocument();
      expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
      expect(target.onAddMediaSuccess).not.toHaveBeenCalled();
      if (change === 'close') {
        rerender(<YouTubeImportDialog {...props} />);
        expect(screen.getByLabelText('YouTube video URL')).toHaveValue(url);
      }
    },
  );

  test('requires mixed-link confirmation and keeps URL and intent on failed catalogue-only retry', async () => {
    boundary.importVideo
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(response());
    const { user } = renderWithProviders(
      <YouTubeImportDialog open source={source} onClose={vi.fn()} />,
    );
    const mixedUrl = `${url}&list=PL-example`;
    await user.type(screen.getByLabelText('YouTube video URL'), mixedUrl);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(boundary.importVideo).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('checkbox', { name: 'Import only this video' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByLabelText('YouTube video URL')).toHaveValue(mixedUrl);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('A finite video')).toBeInTheDocument();
    expect(boundary.importVideo).toHaveBeenCalledTimes(2);
    expect(boundary.importVideo.mock.calls[1][0]).toMatchObject({
      path: { id: source.id },
      body: { url: mixedUrl, intent: 'video' },
      throwOnError: true,
    });
    expect(
      screen.queryByRole('button', { name: 'Add to programming' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Imported into the library. Playback has not been verified.',
      ),
    ).toBeInTheDocument();
  });
});
