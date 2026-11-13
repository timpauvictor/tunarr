import { Trans, useLingui } from '@lingui/react/macro';
import { ImageNotSupported } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Link as MuiLink,
  MenuItem,
  Pagination,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import type { MediaSourceSettings } from '@tunarr/types';
import type {
  YouTubeCollection,
  YouTubeCollectionEntry,
  YouTubeLinksImportResponse,
} from '@tunarr/types/schemas';
import { useEffect, useRef, useState } from 'react';
import type { ProgrammingSelectionContextType } from '../../context/ProgrammingSelectionContext.ts';
import {
  getApiMediaSourcesQueryKey,
  getYouTubeCollectionsOptions,
  getYouTubeCollectionsQueryKey,
  postApiProgramsSearchQueryKey,
} from '../../generated/@tanstack/react-query.gen.ts';
import {
  getYouTubeCollectionEntries,
  importYouTubeLinks,
} from '../../generated/sdk.gen.ts';
import { Imported } from '../../helpers/constants.ts';
import type { AddedMedia } from '../../types/index.ts';
import { useGetArtworkUrl } from '../../hooks/useThumbnailUrl.ts';
import { Segmented } from '../ui/Segmented.tsx';

type ProgrammingTarget = Pick<
  ProgrammingSelectionContextType,
  'entityType' | 'onAddSelectedMedia' | 'onAddMediaSuccess'
>;
type Props = {
  open: boolean;
  onClose: () => void;
  source: Extract<MediaSourceSettings, { type: 'youtube' }>;
  programming?: ProgrammingTarget;
};
type ImportRequest = {
  controller: AbortController;
  pathname: string;
  sourceId: string;
  entityType?: ProgrammingTarget['entityType'];
  append?: ProgrammingTarget['onAddSelectedMedia'];
};
type Review = { request: ImportRequest; result: YouTubeLinksImportResponse };
type Link = { id: string; url: string; intent?: 'video' | 'playlist' };
type LinkDraft = { text: string; links: Link[] };

function editLinks(previous: LinkDraft, text: string): LinkDraft {
  const retained = new Map<string, Link[]>();
  for (const link of previous.links) {
    const matches = retained.get(link.url) ?? [];
    matches.push(link);
    retained.set(link.url, matches);
  }
  return {
    text,
    links: text
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean)
      .map(
        (url) => retained.get(url)?.shift() ?? { id: crypto.randomUUID(), url },
      ),
  };
}
function isMixedVideoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.searchParams.has('list') &&
      (url.searchParams.has('v') ||
        url.hostname === 'youtu.be' ||
        /^\/(shorts|embed)\//.test(url.pathname))
    );
  } catch {
    return false;
  }
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

export function YouTubeImportDialog({
  open,
  onClose,
  source,
  programming,
}: Props) {
  const { t } = useLingui();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const getArtworkUrl = useGetArtworkUrl();
  const [draft, setDraft] = useState<LinkDraft>({ text: '', links: [] });
  const [mode, setMode] = useState<'links' | 'collections'>('links');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [collectionId, setCollectionId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [failedAction, setFailedAction] = useState<
    'links' | 'load' | 'refresh'
  >();
  const [review, setReview] = useState<Review>();
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [addedIds, setAddedIds] = useState(new Set<string>());
  const [partialConfirmed, setPartialConfirmed] = useState(false);
  const [failedArtwork, setFailedArtwork] = useState(new Set<string>());
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const active = useRef<ImportRequest | undefined>(undefined);
  const errorFocus = useRef<HTMLDivElement>(null);
  const reviewFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || pending) {
      return;
    }
    if (error) {
      errorFocus.current?.focus();
    } else if (review) {
      reviewFocus.current?.focus();
    }
  }, [open, pending, error, review]);
  const current = useRef({ open, pathname, sourceId: source.id, programming });
  current.current = { open, pathname, sourceId: source.id, programming };
  const append = programming?.onAddSelectedMedia;
  const entityType = programming?.entityType;
  const collections = useQuery({
    ...getYouTubeCollectionsOptions({ path: { id: source.id } }),
    enabled: open && mode === 'collections',
  });
  const selectedCollection =
    collections.data?.find((collection) => collection.id === collectionId) ??
    collections.data?.[0];

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
  }, [open, pathname, source.id, entityType, append]);
  useEffect(() => {
    setAddedIds(new Set());
  }, [pathname, source.id, entityType, append]);
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
        queryKey: getYouTubeCollectionsQueryKey({ path: { id: source.id } }),
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
      sourceId: source.id,
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
    } catch {
      if (isCurrent(request)) {
        setError(
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
  const importLinks = (refresh = false, collection?: YouTubeCollection) =>
    run(refresh ? 'refresh' : 'links', async (request) => {
      const inputs = collection
        ? [{ url: collectionUrl(collection), order }]
        : draft.links.map((link) => ({
            url: link.url,
            intent: link.intent,
            order,
          }));
      const { data } = await importYouTubeLinks({
        path: { id: source.id },
        body: { inputs, refresh },
        signal: request.controller.signal,
        throwOnError: true,
      });
      return data;
    });
  const loadCollection = (collection: YouTubeCollection) =>
    run('load', async (request) => {
      const entries: YouTubeCollectionEntry[] = [];
      let offset = 0;
      let revision: string | undefined;
      let result: YouTubeLinksImportResponse | undefined;
      while (true) {
        const { data } = await getYouTubeCollectionEntries({
          path: { id: source.id, collectionId: collection.id },
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
  const canImport =
    draft.links.length > 0 &&
    draft.links.length <= 50 &&
    draft.links.every((link) => !isMixedVideoUrl(link.url) || !!link.intent);
  const close = () => {
    invalidate();
    setPending(false);
    setReview(undefined);
    onClose();
  };
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

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="md"
      aria-labelledby="youtube-import-title"
    >
      <DialogTitle id="youtube-import-title">
        <Trans>Import YouTube links</Trans>
      </DialogTitle>
      <DialogContent aria-busy={pending} sx={{ overflowWrap: 'anywhere' }}>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>
            <Trans>
              Import videos, playlists or creator uploads into {source.name}.
              Input order and playlist repeats are preserved.
            </Trans>
          </Typography>
          <Alert severity="info">
            <Trans>
              Only import content you are authorized to use. Import saves
              metadata, not a video download or playback verification.
              Refreshing updates this library, not existing channel programming.
            </Trans>
          </Alert>
          <Tabs
            value={mode}
            onChange={(_, value: 'links' | 'collections') => {
              resetReview();
              setMode(value);
            }}
            aria-label={t`YouTube import mode`}
          >
            <Tab value="links" label={t`Paste links`} disabled={pending} />
            <Tab
              value="collections"
              label={t`Saved collections`}
              disabled={pending}
            />
          </Tabs>
          {mode === 'links' ? (
            <>
              <TextField
                label={t`YouTube URLs (one per line)`}
                value={draft.text}
                multiline
                autoFocus
                minRows={3}
                fullWidth
                disabled={pending}
                onChange={(event) => {
                  resetReview();
                  const text = event.target.value;
                  setDraft((previous) => editLinks(previous, text));
                }}
              />
              {draft.links.length > 50 && (
                <Alert severity="error">
                  <Trans>Import at most 50 URLs per request.</Trans>
                </Alert>
              )}
              {draft.links
                .filter((link) => isMixedVideoUrl(link.url))
                .map((link) => (
                  <TextField
                    key={link.id}
                    select
                    fullWidth
                    label={t`Choose video or playlist for ${link.url}`}
                    value={link.intent ?? ''}
                    disabled={pending}
                    onChange={(event) => {
                      resetReview();
                      const value = event.target.value;
                      setDraft((previous) => ({
                        ...previous,
                        links: previous.links.map((row) =>
                          row.id === link.id
                            ? {
                                ...row,
                                intent:
                                  value === 'video' || value === 'playlist'
                                    ? value
                                    : undefined,
                              }
                            : row,
                        ),
                      }));
                    }}
                  >
                    <MenuItem value="">
                      <Trans>Choose intent</Trans>
                    </MenuItem>
                    <MenuItem value="video">
                      <Trans>Only this video</Trans>
                    </MenuItem>
                    <MenuItem value="playlist">
                      <Trans>The complete playlist</Trans>
                    </MenuItem>
                  </TextField>
                ))}
            </>
          ) : (
            <>
              {collections.isPending ? (
                <LinearProgress aria-label={t`Loading collections`} />
              ) : collections.isError ? (
                <Alert severity="error">
                  <Trans>Could not load saved collections.</Trans>
                  <Button
                    onClick={() => {
                      void collections.refetch();
                    }}
                  >
                    <Trans>Retry</Trans>
                  </Button>
                </Alert>
              ) : !collections.data?.length ? (
                <Alert severity="info">
                  <Trans>No collections yet. Paste links to import one.</Trans>
                </Alert>
              ) : (
                <>
                  <TextField
                    select
                    label={t`Saved collection`}
                    value={selectedCollection?.id ?? ''}
                    disabled={pending}
                    onChange={(event) => {
                      resetReview();
                      setCollectionId(event.target.value);
                    }}
                  >
                    {collections.data.map((collection) => (
                      <MenuItem key={collection.id} value={collection.id}>
                        {collection.title}
                      </MenuItem>
                    ))}
                  </TextField>
                  {selectedCollection?.lastSuccessfulRefreshAt && (
                    <Typography variant="body2">
                      <Trans>Last successful refresh:</Trans>{' '}
                      {new Date(
                        selectedCollection.lastSuccessfulRefreshAt,
                      ).toLocaleString()}
                    </Typography>
                  )}
                  {selectedCollection?.lastRefreshError && (
                    <Alert severity="warning">
                      <Trans>
                        The last refresh failed. The previous complete
                        collection was retained.
                      </Trans>
                      <Typography variant="body2">
                        {selectedCollection.lastRefreshError}
                      </Typography>
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1}>
                    <Button
                      disabled={pending || !selectedCollection}
                      onClick={() => {
                        if (selectedCollection) {
                          void loadCollection(selectedCollection);
                        }
                      }}
                    >
                      {error && failedAction === 'load' ? (
                        <Trans>Retry loading collection</Trans>
                      ) : (
                        <Trans>Load collection</Trans>
                      )}
                    </Button>
                    {selectedCollection &&
                      selectedCollection.kind !== 'saved_videos' && (
                        <Button
                          disabled={pending}
                          onClick={() => {
                            void importLinks(true, selectedCollection);
                          }}
                        >
                          {error && failedAction === 'refresh' ? (
                            <Trans>Retry refresh</Trans>
                          ) : (
                            <Trans>Refresh collection</Trans>
                          )}
                        </Button>
                      )}
                  </Stack>
                </>
              )}
            </>
          )}
          <TextField
            select
            label={t`Creator upload order`}
            value={order}
            disabled={pending}
            onChange={(event) => {
              resetReview();
              setOrder(event.target.value === 'oldest' ? 'oldest' : 'newest');
            }}
          >
            <MenuItem value="newest">
              <Trans>Newest first</Trans>
            </MenuItem>
            <MenuItem value="oldest">
              <Trans>Oldest first</Trans>
            </MenuItem>
          </TextField>
          {pending && (
            <LinearProgress aria-label={t`Importing YouTube metadata`} />
          )}
          {error && (
            <Alert severity="error" ref={errorFocus} tabIndex={-1}>
              {error}
            </Alert>
          )}
          {review && (
            <>
              {review.result.imports.map((input) => (
                <Box key={input.inputIndex}>
                  <Typography variant="h6">
                    {input.kind === 'video' ? t`Video import` : input.title}
                  </Typography>
                  {input.message && (
                    <Alert
                      severity={input.status === 'failed' ? 'error' : 'warning'}
                    >
                      {input.status === 'failed' ? (
                        <Trans>
                          Import failed. Retry when the source is available.
                        </Trans>
                      ) : input.status === 'duplicate' ? (
                        <Trans>Repeated input was not imported twice.</Trans>
                      ) : (
                        <Trans>Import details</Trans>
                      )}
                      <Typography variant="body2">{input.message}</Typography>
                    </Alert>
                  )}
                  {input.changes && (
                    <Typography>
                      <Trans>
                        Added: {input.changes.added}; removed:{' '}
                        {input.changes.removed}
                      </Trans>
                    </Typography>
                  )}
                </Box>
              ))}
              <Typography
                component="div"
                role="status"
                ref={reviewFocus}
                tabIndex={-1}
              >
                <Trans>
                  Eligible: {available.length}; pending: {pendingCount};
                  unavailable: {unavailableCount}
                </Trans>
              </Typography>
              {!entries.length && (
                <Alert severity="info">
                  <Trans>
                    No entries to add. Saved programming was not changed.
                  </Trans>
                </Alert>
              )}
              {programming && (
                <Stack direction="row" spacing={1}>
                  <Button
                    onClick={() =>
                      setSelectedIds(
                        new Set(
                          available
                            .filter((entry) => !addedIds.has(entry.id))
                            .map((entry) => entry.id),
                        ),
                      )
                    }
                  >
                    <Trans>Select all eligible</Trans>
                  </Button>
                  <Button onClick={() => setSelectedIds(new Set())}>
                    <Trans>Clear selection</Trans>
                  </Button>
                </Stack>
              )}
              <Segmented
                value={view}
                onChange={setView}
                aria-label={t`Collection view`}
                options={[
                  { value: 'list', label: t`List` },
                  { value: 'grid', label: t`Grid` },
                ]}
              />
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns:
                    view === 'grid'
                      ? { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }
                      : '1fr',
                  gap: 2,
                }}
              >
                {entries
                  .slice((page - 1) * 50, page * 50)
                  .map((entry, index) => {
                    const program = entry.program?.program;
                    const artwork = program
                      ? getArtworkUrl(program, ['thumbnail', 'poster'])
                      : null;
                    return (
                      <Stack
                        key={entry.id}
                        spacing={1}
                        sx={{
                          p: 1,
                          border: 1,
                          borderColor: 'divider',
                          borderRadius: 1,
                        }}
                      >
                        {programming && (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={
                                  selectedIds.has(entry.id) &&
                                  !addedIds.has(entry.id)
                                }
                                disabled={
                                  !eligible(entry) || addedIds.has(entry.id)
                                }
                                onChange={(_, checked) =>
                                  setSelectedIds((previous) => {
                                    const next = new Set(previous);
                                    if (checked) {
                                      next.add(entry.id);
                                    } else {
                                      next.delete(entry.id);
                                    }
                                    return next;
                                  })
                                }
                              />
                            }
                            label={t`Select occurrence ${(page - 1) * 50 + index + 1}`}
                          />
                        )}
                        {artwork && !failedArtwork.has(artwork) ? (
                          <Box
                            component="img"
                            src={artwork}
                            alt={program?.title ?? ''}
                            onError={() =>
                              setFailedArtwork(
                                (previous) => new Set([...previous, artwork]),
                              )
                            }
                            sx={{
                              maxWidth: '100%',
                              height: 100,
                              objectFit: 'contain',
                            }}
                          />
                        ) : (
                          <ImageNotSupported
                            aria-label={t`No artwork available`}
                          />
                        )}
                        <Typography variant="subtitle1">
                          {program?.title ??
                            entry.videoId ??
                            t`Unavailable entry`}
                        </Typography>
                        {program?.type === 'other_video' &&
                          program.youtubeMetadata?.creatorName && (
                            <Typography>
                              {program.youtubeMetadata.creatorName}
                            </Typography>
                          )}
                        {entry.program && (
                          <Typography>
                            <Trans>
                              Duration:{' '}
                              {Math.floor(entry.program.duration / 60000)} min{' '}
                              {Math.floor(
                                (entry.program.duration % 60000) / 1000,
                              )}{' '}
                              sec
                            </Trans>
                          </Typography>
                        )}
                        {program && 'summary' in program && program.summary && (
                          <Typography variant="body2">
                            {program.summary}
                          </Typography>
                        )}
                        {entry.videoId && (
                          <MuiLink
                            href={`https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Trans>Open video on YouTube</Trans>
                          </MuiLink>
                        )}
                        {entry.status !== 'available' && (
                          <Alert severity="warning">
                            {entry.status === 'pending' ? (
                              <Trans>Pending metadata</Trans>
                            ) : (
                              <Trans>Unavailable</Trans>
                            )}
                            {entry.message && (
                              <Typography variant="body2">
                                {entry.message}
                              </Typography>
                            )}
                          </Alert>
                        )}
                      </Stack>
                    );
                  })}
              </Box>
              {entries.length > 50 && (
                <Pagination
                  count={Math.ceil(entries.length / 50)}
                  page={page}
                  onChange={(_, value) => setPage(value)}
                  aria-label={t`Collection pages`}
                />
              )}
              {review.result.imports.some(
                (input) => input.status === 'complete',
              ) ? (
                <Alert severity="success">
                  <Trans>
                    Imported into the library. Playback has not been verified.
                  </Trans>
                </Alert>
              ) : (
                <Alert severity="info">
                  <Trans>
                    No new metadata was imported. Saved programming was not
                    changed.
                  </Trans>
                </Alert>
              )}
              <Alert severity="info">
                <Trans>
                  Separate audio/video inputs require transcoding. ErsatzTV
                  playback requires dynamic playout; static windows are not
                  supported. Change incompatible profiles explicitly. Normal
                  channels advance while unwatched; pause-on-idle is a separate
                  channel setting.
                </Trans>
              </Alert>
              {programming && (
                <Typography variant="body2">
                  <Trans>
                    Add to the current draft, then use normal Save to persist
                    programming.
                  </Trans>
                </Typography>
              )}
              {programming && requiresConfirmation && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={partialConfirmed}
                      onChange={(_, checked) => setPartialConfirmed(checked)}
                    />
                  }
                  label={t`I understand that excluded entries will not be added`}
                />
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={close}>
          <Trans>Close</Trans>
        </Button>
        {pending ? (
          <Button
            onClick={() => {
              invalidate();
              setPending(false);
              setReview(undefined);
              setError(
                t`Operation cancelled. Your inputs and saved programming were kept. You can retry.`,
              );
              setPartialConfirmed(false);
            }}
          >
            <Trans>Cancel import</Trans>
          </Button>
        ) : (
          mode === 'links' && (
            <Button
              disabled={!canImport || !!review}
              onClick={() => {
                void importLinks();
              }}
            >
              {error ? <Trans>Retry</Trans> : <Trans>Import</Trans>}
            </Button>
          )
        )}
        {programming && (
          <Button
            variant="contained"
            disabled={
              !review ||
              pending ||
              !selected.length ||
              (requiresConfirmation && !partialConfirmed) ||
              !isCurrent(review.request)
            }
            onClick={add}
          >
            <Trans>Add to programming</Trans>
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
