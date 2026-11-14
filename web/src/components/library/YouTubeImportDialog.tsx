import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import type { MediaSourceSettings } from '@tunarr/types';
import { useEffect, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { getYouTubeCollectionsOptions } from '../../generated/@tanstack/react-query.gen.ts';
import {
  useYouTubeImport,
  youtubeErrorMessage,
} from '../../hooks/media-sources/useYouTubeImport.ts';
import type { YouTubeProgrammingTarget } from '../../hooks/media-sources/useYouTubeImport.ts';
import { YouTubeImportReview } from './YouTubeImportReview.tsx';

type Props = {
  open: boolean;
  onClose: () => void;
  source: Extract<MediaSourceSettings, { type: 'youtube' }>;
  programming?: YouTubeProgrammingTarget;
};
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
      .map((url) => retained.get(url)?.shift() ?? { id: v4(), url }),
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

export function YouTubeImportDialog({
  open,
  onClose,
  source,
  programming,
}: Props) {
  const { t } = useLingui();
  const { pathname } = useLocation();
  const [draft, setDraft] = useState<LinkDraft>({ text: '', links: [] });
  const [mode, setMode] = useState<'links' | 'collections'>('links');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [collectionId, setCollectionId] = useState('');
  const [failedArtwork, setFailedArtwork] = useState(new Set<string>());
  const [view, setView] = useState<'list' | 'grid'>('list');
  const {
    result: review,
    reviewModel,
    pending,
    error,
    failedAction,
    canAdd,
    importLinks: submitLinks,
    refreshCollection,
    loadCollection,
    resetReview,
    dismiss,
    cancel,
    toggleSelection,
    selectAll,
    clearSelection,
    confirmPartial,
    setPage,
    add,
  } = useYouTubeImport({ open, pathname, sourceId: source.id, programming });
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
  const collections = useQuery({
    ...getYouTubeCollectionsOptions({ path: { id: source.id } }),
    enabled: open && mode === 'collections',
  });
  const selectedCollection =
    collections.data?.find((collection) => collection.id === collectionId) ??
    collections.data?.[0];
  const importLinks = () =>
    submitLinks(
      draft.links.map((link) => ({
        url: link.url,
        intent: link.intent,
        order,
      })),
    );
  const canImport =
    draft.links.length > 0 &&
    draft.links.length <= 50 &&
    draft.links.every((link) => !isMixedVideoUrl(link.url) || !!link.intent);
  const close = () => {
    dismiss();
    onClose();
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
                  {youtubeErrorMessage(collections.error) ?? (
                    <Trans>Could not load saved collections.</Trans>
                  )}
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
                          void loadCollection(selectedCollection, order);
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
                            void refreshCollection(selectedCollection, order);
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
          {reviewModel && (
            <YouTubeImportReview
              review={reviewModel}
              statusRef={reviewFocus}
              selection={
                programming
                  ? {
                      toggle: toggleSelection,
                      selectAll,
                      clear: clearSelection,
                      confirmPartial,
                    }
                  : undefined
              }
              onPageChange={setPage}
              view={view}
              onViewChange={setView}
              failedArtwork={failedArtwork}
              onArtworkFailure={(artwork) =>
                setFailedArtwork((previous) => new Set([...previous, artwork]))
              }
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={close}>
          <Trans>Close</Trans>
        </Button>
        {pending ? (
          <Button onClick={cancel}>
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
          <Button variant="contained" disabled={!canAdd} onClick={add}>
            <Trans>Add to programming</Trans>
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
