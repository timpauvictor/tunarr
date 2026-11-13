import type { ContentProgram, MediaSourceSettings } from '@tunarr/types';
import type {
  YouTubeCollection,
  YouTubeCollectionEntry,
  YouTubeLinksImportResponse,
} from '@tunarr/types/schemas';
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
  importLinks: vi.fn(),
  collections: vi.fn(),
  page: vi.fn(),
  pathname: '/channels/channel-1/programming/add',
}));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: boundary.pathname }),
}));
vi.mock('../../generated/sdk.gen.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  importYouTubeLinks: boundary.importLinks,
  getYouTubeCollections: boundary.collections,
  getYouTubeCollectionEntries: boundary.page,
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
const collection: YouTubeCollection = {
  id: 'collection-1',
  sourceId: source.id,
  title: 'Ordered playlist',
  kind: 'playlist',
  externalKey: 'playlist:PLfixture',
  revision: 'snapshot-1',
  lastSuccessfulRefreshAt: 1794256505000,
  lastRefreshError: null,
};
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const label = 'YouTube URLs (one per line)';

async function pasteLinks(
  user: ReturnType<typeof renderWithProviders>['user'],
  text: string,
) {
  // Exercise real URL pasting without rerendering the dialog for every character.
  await user.click(screen.getByLabelText(label));
  await user.paste(text);
}

function entry(
  id: string,
  program: ContentProgram | null = video,
  position = 0,
): YouTubeCollectionEntry {
  return {
    id,
    position,
    videoId: 'abcdefghijk',
    status: program ? 'available' : 'pending',
    message: program ? null : 'Duration is still missing.',
    program,
  };
}
function response(
  entries = [entry('saved-one')],
  kind: 'video' | 'playlist' = 'video',
) {
  const data: YouTubeLinksImportResponse = {
    sourceId: source.id,
    libraryId: 'saved-videos',
    imports: [
      {
        inputIndex: 0,
        kind,
        title: kind === 'video' ? 'Video import' : collection.title,
        status: 'complete',
        message: null,
        collection: kind === 'video' ? null : collection,
        entries,
      },
    ],
  };
  return { data };
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

describe('shared YouTube import and collection SDK boundary', () => {
  beforeEach(() => {
    boundary.importLinks.mockReset();
    boundary.collections.mockReset().mockResolvedValue({ data: [] });
    boundary.page.mockReset();
    boundary.pathname = '/channels/channel-1/programming/add';
  });

  test('reviews metadata, requires explicit Add, preserves a mixed draft and blocks duplicate Add after reimport', async () => {
    boundary.importLinks.mockResolvedValue(response());
    const draft: AddedMedia[] = [
      { type: Imported, media: makeContentProgram(makeMovie(), 60000) },
    ];
    const existing = draft[0],
      target = programmingTarget();
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
    await pasteLinks(user, url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('A finite video')).toBeInTheDocument();
    expect(screen.getByText('Example creator')).toBeInTheDocument();
    expect(screen.getByText('Saved description')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
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
    await user.clear(screen.getByLabelText(label));
    await pasteLinks(user, url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('A finite video');
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    expect(target.onAddSelectedMedia).toHaveBeenCalledOnce();
  });

  test('cancels the exact signal, retains inputs and ignores an old completion while retry is pending', async () => {
    const old = deferred(),
      retry = deferred(),
      target = programmingTarget();
    boundary.importLinks
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(retry.promise);
    const { user } = renderWithProviders(
      <YouTubeImportDialog
        open
        source={source}
        onClose={vi.fn()}
        programming={target}
      />,
    );
    await pasteLinks(user, url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const signal: AbortSignal = boundary.importLinks.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByLabelText(label)).toHaveValue(url);
    await waitFor(() =>
      expect(
        screen.getByText(/Operation cancelled/).closest('[role="alert"]'),
      ).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      old.resolve(response());
    });
    expect(screen.queryByText('A finite video')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('Importing YouTube metadata'),
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
      const pending = deferred(),
        target = programmingTarget(),
        onClose = vi.fn();
      boundary.importLinks.mockReturnValue(pending.promise);
      const props = { open: true, source, onClose, programming: target };
      const { user, rerender } = renderWithProviders(
        <YouTubeImportDialog {...props} />,
      );
      await pasteLinks(user, url);
      await user.click(screen.getByRole('button', { name: 'Import' }));
      const signal: AbortSignal = boundary.importLinks.mock.calls[0][0].signal;
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
        expect(screen.getByLabelText(label)).toHaveValue(url);
      }
    },
  );

  test('requires explicit mixed-link intent and retains it on failed catalogue-only retry', async () => {
    boundary.importLinks
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(response());
    const { user } = renderWithProviders(
      <YouTubeImportDialog open source={source} onClose={vi.fn()} />,
    );
    const mixedUrl = `${url}&list=PLfixture`;
    await pasteLinks(user, mixedUrl);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(boundary.importLinks).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('combobox', { name: /Choose video or playlist/ }),
    );
    await user.click(screen.getByRole('option', { name: 'Only this video' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByLabelText(label)).toHaveValue(mixedUrl);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('A finite video')).toBeInTheDocument();
    expect(boundary.importLinks).toHaveBeenCalledTimes(2);
    expect(boundary.importLinks.mock.calls[1][0]).toMatchObject({
      path: { id: source.id },
      body: {
        inputs: [{ url: mixedUrl, intent: 'video', order: 'newest' }],
        refresh: false,
      },
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

  test('adds repeated occurrences in input order only after explicit partial-set confirmation', async () => {
    const repeated = [
      entry('a-first'),
      entry('a-second', video, 1),
      entry('pending', null, 2),
    ];
    boundary.importLinks.mockResolvedValue(response(repeated, 'playlist'));
    const target = programmingTarget(),
      { user } = renderWithProviders(
        <YouTubeImportDialog
          open
          source={source}
          onClose={vi.fn()}
          programming={target}
        />,
      );
    await pasteLinks(
      user,
      'https://www.youtube.com/playlist?list=PLfixture\nhttps://www.youtube.com/@Example',
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(collection.title);
    expect(
      screen.getByText('Eligible: 2; pending: 1; unavailable: 0'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand that excluded entries will not be added',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    expect(target.onAddSelectedMedia).toHaveBeenCalledExactlyOnceWith([
      { type: Imported, media: video },
      { type: Imported, media: video },
    ]);
    expect(
      boundary.importLinks.mock.calls[0][0].body.inputs.map(
        (input: { url: string }) => input.url,
      ),
    ).toEqual([
      'https://www.youtube.com/playlist?list=PLfixture',
      'https://www.youtube.com/@Example',
    ]);
  });

  test('selection survives pagination and grid/list changes without collapsing repeated programme IDs', async () => {
    const repeated = Array.from({ length: 51 }, (_, index) =>
      entry(`occurrence-${index}`, video, index),
    );
    boundary.importLinks.mockResolvedValue(response(repeated, 'playlist'));
    const target = programmingTarget(),
      { user } = renderWithProviders(
        <YouTubeImportDialog
          open
          source={source}
          onClose={vi.fn()}
          programming={target}
        />,
      );
    await pasteLinks(user, 'https://www.youtube.com/playlist?list=PLfixture');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(collection.title);
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Select occurrence 1',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Go to page 2' }));
    expect(
      screen.getByRole('checkbox', { name: 'Select occurrence 51' }),
    ).toBeChecked();
    await user.click(
      screen.getByRole('checkbox', { name: 'Select occurrence 51' }),
    );
    await user.click(screen.getByRole('button', { name: 'Grid' }));
    await user.click(screen.getByRole('button', { name: 'Go to page 1' }));
    expect(
      screen.getByRole('checkbox', {
        name: 'Select occurrence 1',
      }),
    ).not.toBeChecked();
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    const added: AddedMedia[] = target.onAddSelectedMedia.mock.calls[0][0];
    expect(added).toHaveLength(49);
    expect(added).toEqual(
      Array.from({ length: 49 }, () => ({ type: Imported, media: video })),
    );
  }, 15000);

  test('loads all collection pages with the captured revision and explicit creator order, without metadata import', async () => {
    const creator = {
        ...collection,
        kind: 'creator_uploads' as const,
        externalKey: 'creator:UCSMOQeBJ2RAnuFungnQOxLg',
        title: 'Creator uploads',
      },
      repeated = Array.from({ length: 101 }, (_, index) =>
        entry(`creator-${index}`, video, index),
      );
    boundary.collections.mockResolvedValue({ data: [creator] });
    boundary.page.mockImplementation(
      ({ query }: { query: { offset: number } }) =>
        Promise.resolve({
          data: {
            sourceId: source.id,
            libraryId: 'saved-videos',
            collection: creator,
            total: 101,
            entries: repeated.slice(query.offset, query.offset + 100),
          },
        }),
    );
    const target = programmingTarget(),
      { user } = renderWithProviders(
        <YouTubeImportDialog
          open
          source={source}
          onClose={vi.fn()}
          programming={target}
        />,
      );
    await user.click(screen.getByRole('tab', { name: 'Saved collections' }));
    await screen.findByRole('button', { name: 'Load collection' });
    await user.click(
      screen.getByRole('combobox', { name: /^Creator upload order/ }),
    );
    await user.click(screen.getByRole('option', { name: 'Oldest first' }));
    await user.click(screen.getByRole('button', { name: 'Load collection' }));
    await screen.findByText('Eligible: 101; pending: 0; unavailable: 0');
    expect(boundary.page).toHaveBeenCalledTimes(2);
    expect(boundary.page.mock.calls[1][0]).toMatchObject({
      query: {
        offset: 100,
        limit: 100,
        order: 'oldest',
        revision: collection.revision,
      },
    });
    expect(boundary.importLinks).not.toHaveBeenCalled();
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    expect(target.onAddSelectedMedia.mock.calls[0][0]).toHaveLength(101);
  }, 15000);

  test('an incomplete collection page sequence cannot become an eligible Add result', async () => {
    boundary.collections.mockResolvedValue({ data: [collection] });
    boundary.page
      .mockResolvedValueOnce({
        data: {
          sourceId: source.id,
          libraryId: 'saved-videos',
          collection,
          total: 2,
          entries: [entry('one')],
        },
      })
      .mockRejectedValueOnce(new Error('Collection changed while paging'));
    const target = programmingTarget(),
      { user } = renderWithProviders(
        <YouTubeImportDialog
          open
          source={source}
          onClose={vi.fn()}
          programming={target}
        />,
      );
    await user.click(screen.getByRole('tab', { name: 'Saved collections' }));
    await screen.findByRole('button', { name: 'Load collection' });
    await user.click(screen.getByRole('button', { name: 'Load collection' }));
    await screen.findByText(/Could not finish\. Check the links/);
    await waitFor(() => expect(boundary.page).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
    boundary.page.mockResolvedValueOnce({
      data: {
        sourceId: source.id,
        libraryId: 'saved-videos',
        collection,
        total: 1,
        entries: [entry('one')],
      },
    });
    await user.click(
      screen.getByRole('button', { name: 'Retry loading collection' }),
    );
    await screen.findByText('Eligible: 1; pending: 0; unavailable: 0');
    expect(boundary.page.mock.calls[2][0].query.offset).toBe(0);
    expect(boundary.importLinks).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Add to programming' }),
    );
    expect(target.onAddSelectedMedia).toHaveBeenCalledTimes(1);
  });

  test('empty results and unavailable metadata remain honest and cannot be added', async () => {
    boundary.importLinks.mockResolvedValueOnce(response([]));
    const target = programmingTarget();
    const { user } = renderWithProviders(
      <YouTubeImportDialog
        open
        source={source}
        onClose={vi.fn()}
        programming={target}
      />,
    );
    await pasteLinks(user, url);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(
      'No entries to add. Saved programming was not changed.',
    );
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText(label), ' ');
    boundary.importLinks.mockResolvedValueOnce(
      response([
        {
          ...entry('gone', null),
          status: 'unavailable',
          message: 'Video was removed.',
        },
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('Unavailable');
    expect(screen.getByText('Video was removed.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open video on YouTube' }),
    ).toHaveAttribute('href', url);
    expect(
      screen.getByRole('button', { name: 'Add to programming' }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText(label), ' ');
    const failed = response([]);
    failed.data.imports[0].status = 'failed';
    failed.data.imports[0].message = 'Fixture access denied.';
    boundary.importLinks.mockResolvedValueOnce(failed);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(
      'No new metadata was imported. Saved programming was not changed.',
    );
    expect(
      screen.queryByText(
        'Imported into the library. Playback has not been verified.',
      ),
    ).not.toBeInTheDocument();
    expect(target.onAddSelectedMedia).not.toHaveBeenCalled();
  });
});
