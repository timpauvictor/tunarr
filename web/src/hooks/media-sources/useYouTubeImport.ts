import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import type {
  YouTubeCollection,
  YouTubeCollectionEntry,
  YouTubeLinkInput,
  YouTubeLinksImportResponse,
} from '@tunarr/types/schemas';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';
import type { ProgrammingSelectionContextType } from '../../context/ProgrammingSelectionContext.ts';
import {
  getApiMediaSourcesQueryKey,
  getYouTubeCollectionsQueryKey,
  postApiProgramsSearchQueryKey,
} from '../../generated/@tanstack/react-query.gen.ts';
import {
  getYouTubeCollectionEntries,
  importYouTubeLinks,
} from '../../generated/sdk.gen.ts';
import { Imported } from '../../helpers/constants.ts';
import { isNonEmptyString } from '../../helpers/util.ts';
import type { AddedMedia } from '../../types/index.ts';

export type YouTubeProgrammingTarget = Pick<
  ProgrammingSelectionContextType,
  'entityType' | 'onAddSelectedMedia' | 'onAddMediaSuccess'
>;
type ImportRequest = {
  controller: AbortController;
  pathname: string;
  sourceId: string;
  entityType?: YouTubeProgrammingTarget['entityType'];
  append?: YouTubeProgrammingTarget['onAddSelectedMedia'];
};
type Review = { request: ImportRequest; result: YouTubeLinksImportResponse };
type YouTubeReviewRow = {
  entry: YouTubeCollectionEntry;
  ordinal: number;
  selected: boolean;
  selectable: boolean;
};
export type YouTubeImportReviewModel = {
  result: YouTubeLinksImportResponse;
  rows: readonly YouTubeReviewRow[];
  available: readonly YouTubeCollectionEntry[];
  pendingCount: number;
  unavailableCount: number;
  requiresConfirmation: boolean;
  partialConfirmed: boolean;
  page: number;
};
type Options = {
  open: boolean;
  pathname: string;
  sourceId: string;
  programming?: YouTubeProgrammingTarget;
};

export function youtubeErrorMessage(error: unknown): string | undefined {
  if (!isAxiosError<unknown>(error)) {
    return;
  }
  const response = error.response;
  if (!response || ![400, 409, 503].includes(response.status)) {
    return;
  }
  const message = isNonEmptyString(response.data)
    ? response.data.trim()
    : undefined;
  return isNonEmptyString(message) ? message : undefined;
}

function collectionUrl(collection: YouTubeCollection): string {
  if (collection.kind === 'playlist') {
    return `https://www.youtube.com/playlist?list=${collection.externalKey.slice('playlist:'.length)}`;
  }
  if (collection.kind === 'creator_uploads') {
    return `https://www.youtube.com/channel/${collection.externalKey.slice('creator:'.length)}`;
  }
  throw new Error('Use the existing library refresh control for Saved Videos.');
}
const eligible = (entry: YouTubeCollectionEntry) =>
  entry.status === 'available' && !!entry.program;

async function importMetadata(
  request: ImportRequest,
  inputs: YouTubeLinkInput[],
  refresh: boolean,
) {
  const { data } = await importYouTubeLinks({
    path: { id: request.sourceId },
    body: { inputs, refresh },
    signal: request.controller.signal,
    throwOnError: true,
  });
  return data;
}

export function useYouTubeImport({
  open,
  pathname,
  sourceId,
  programming,
}: Options) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [failedAction, setFailedAction] = useState<
    'links' | 'load' | 'refresh'
  >();
  const [review, setReview] = useState<Review>();
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [addedIds, setAddedIds] = useState(new Set<string>());
  const [partialConfirmed, setPartialConfirmed] = useState(false);
  const [page, setPage] = useState(1);
  const active = useRef<ImportRequest | undefined>(undefined);
  const current = useRef({ open, pathname, sourceId, programming });
  current.current = { open, pathname, sourceId, programming };
  const append = programming?.onAddSelectedMedia;
  const entityType = programming?.entityType;

  const invalidate = () => {
    active.current?.controller.abort();
    active.current = undefined;
  };
  useEffect(() => {
    setPending(false);
    setReview(undefined);
    setError(undefined);
    return () => {
      active.current?.controller.abort();
      active.current = undefined;
    };
  }, [open, pathname, sourceId, entityType, append]);
  useEffect(() => {
    setAddedIds(new Set());
  }, [pathname, sourceId, entityType, append]);
  const isCurrent = (request: ImportRequest) => {
    const owner = current.current;
    return (
      active.current === request &&
      !request.controller.signal.aborted &&
      owner.open &&
      owner.pathname === request.pathname &&
      owner.sourceId === request.sourceId &&
      owner.programming?.entityType === request.entityType &&
      owner.programming?.onAddSelectedMedia === request.append
    );
  };
  const resetReview = () => {
    invalidate();
    setReview(undefined);
    setError(undefined);
    setPartialConfirmed(false);
  };
  const invalidateCatalogue = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getApiMediaSourcesQueryKey() }),
      queryClient.invalidateQueries({
        queryKey: getYouTubeCollectionsQueryKey({ path: { id: sourceId } }),
      }),
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key: unknown = query.queryKey[0];
          return (
            !!key &&
            typeof key === 'object' &&
            '_id' in key &&
            key._id ===
              postApiProgramsSearchQueryKey({ body: { query: {} } })[0]._id
          );
        },
      }),
      queryClient.invalidateQueries({ queryKey: ['programs'] }),
    ]);
  const run = async (
    action: 'links' | 'load' | 'refresh',
    operation: (request: ImportRequest) => Promise<YouTubeLinksImportResponse>,
  ) => {
    if (active.current && active.current !== review?.request) {
      return;
    }
    invalidate();
    const request: ImportRequest = {
      controller: new AbortController(),
      pathname,
      sourceId,
      entityType,
      append,
    };
    active.current = request;
    setFailedAction(action);
    setPending(true);
    setReview(undefined);
    setError(undefined);
    setPartialConfirmed(false);
    setPage(1);
    try {
      const result = await operation(request);
      if (!isCurrent(request)) {
        return;
      }
      if (result.sourceId !== request.sourceId) {
        throw new Error('Import source changed');
      }
      setReview({ request, result });
      setSelectedIds(
        new Set(
          result.imports
            .flatMap((input) => input.entries)
            .filter((entry) => eligible(entry) && !addedIds.has(entry.id))
            .map((entry) => entry.id),
        ),
      );
      void invalidateCatalogue().catch(console.error);
    } catch (error) {
      if (isCurrent(request)) {
        setError(
          youtubeErrorMessage(error) ??
            t`Could not finish. Check the links and Test setup in Media Sources, then retry. Last complete collections and saved programming were retained.`,
        );
        active.current = undefined;
      }
    } finally {
      if (active.current === request || !active.current) {
        setPending(false);
      }
    }
  };
  const importLinks = (inputs: YouTubeLinkInput[]) =>
    run('links', (request) => importMetadata(request, inputs, false));
  const refreshCollection = (
    collection: YouTubeCollection,
    order: 'newest' | 'oldest',
  ) =>
    run('refresh', (request) =>
      importMetadata(
        request,
        [{ url: collectionUrl(collection), order }],
        true,
      ),
    );
  const loadCollection = (
    collection: YouTubeCollection,
    order: 'newest' | 'oldest',
  ) =>
    run('load', async (request) => {
      const entries: YouTubeCollectionEntry[] = [];
      let offset = 0;
      let revision: string | undefined;
      let result: YouTubeLinksImportResponse | undefined;
      while (true) {
        const { data } = await getYouTubeCollectionEntries({
          path: { id: request.sourceId, collectionId: collection.id },
          query: { offset, limit: 100, order, revision },
          signal: request.controller.signal,
          throwOnError: true,
        });
        request.controller.signal.throwIfAborted();
        if (
          data.sourceId !== request.sourceId ||
          data.total > 10000 ||
          (revision && data.collection.revision !== revision)
        ) {
          throw new Error('Collection identity or safety limit changed');
        }
        revision = data.collection.revision;
        entries.push(...data.entries);
        result = {
          sourceId: data.sourceId,
          libraryId: data.libraryId,
          imports: [
            {
              inputIndex: 0,
              kind:
                collection.kind === 'saved_videos'
                  ? 'video'
                  : collection.kind === 'playlist'
                    ? 'playlist'
                    : 'creator',
              status: 'complete',
              title: collection.title,
              message: null,
              collection: data.collection,
              entries,
            },
          ],
        };
        if (entries.length >= data.total) {
          break;
        }
        if (!data.entries.length) {
          throw new Error('Collection pagination did not finish');
        }
        offset += data.entries.length;
      }
      if (!result) {
        throw new Error('Collection did not load');
      }
      return result;
    });

  const entries =
    review?.result.imports.flatMap((input) => input.entries) ?? [];
  const available = entries.filter(eligible);
  const pendingCount = entries.filter(
    (entry) => entry.status === 'pending',
  ).length;
  const unavailableCount = entries.filter(
    (entry) => entry.status === 'unavailable',
  ).length;
  const requiresConfirmation =
    pendingCount > 0 ||
    unavailableCount > 0 ||
    !!review?.result.imports.some((input) => input.status !== 'complete');
  const selected = available.filter(
    (entry) => selectedIds.has(entry.id) && !addedIds.has(entry.id),
  );
  const rows: YouTubeReviewRow[] = entries.map((entry, index) => ({
    entry,
    ordinal: index + 1,
    selected: selectedIds.has(entry.id) && !addedIds.has(entry.id),
    selectable: eligible(entry) && !addedIds.has(entry.id),
  }));
  const dismiss = () => {
    invalidate();
    setPending(false);
    setReview(undefined);
  };
  const cancel = () => {
    dismiss();
    setError(
      t`Operation cancelled. Your inputs and saved programming were kept. You can retry.`,
    );
    setPartialConfirmed(false);
  };
  const toggleSelection = (id: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const selectAll = () =>
    setSelectedIds(
      new Set(
        available
          .filter((entry) => !addedIds.has(entry.id))
          .map((entry) => entry.id),
      ),
    );
  const clearSelection = () => setSelectedIds(new Set());
  const add = () => {
    if (
      !review ||
      !programming ||
      !isCurrent(review.request) ||
      (requiresConfirmation && !partialConfirmed) ||
      !selected.length
    ) {
      return;
    }
    const media = selected.flatMap<AddedMedia>((entry) =>
      entry.program ? [{ type: Imported, media: entry.program }] : [],
    );
    programming.onAddSelectedMedia(media);
    setAddedIds(
      (previous) =>
        new Set([...previous, ...selected.map((entry) => entry.id)]),
    );
    programming.onAddMediaSuccess();
  };
  const canAdd =
    !!review &&
    !pending &&
    !!selected.length &&
    (!requiresConfirmation || partialConfirmed) &&
    isCurrent(review.request);
  const reviewModel: YouTubeImportReviewModel | undefined = review
    ? {
        result: review.result,
        rows,
        available,
        pendingCount,
        unavailableCount,
        requiresConfirmation,
        partialConfirmed,
        page,
      }
    : undefined;
  return {
    result: review?.result,
    reviewModel,
    pending,
    error,
    failedAction,
    confirmPartial: setPartialConfirmed,
    setPage,
    canAdd,
    importLinks,
    refreshCollection,
    loadCollection,
    resetReview,
    dismiss,
    cancel,
    toggleSelection,
    selectAll,
    clearSelection,
    add,
  };
}
