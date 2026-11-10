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
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import type { ContentProgram, MediaSourceSettings } from '@tunarr/types';
import { useEffect, useRef, useState } from 'react';
import type { ProgrammingSelectionContextType } from '../../context/ProgrammingSelectionContext.ts';
import {
  getApiMediaSourcesQueryKey,
  postApiProgramsSearchQueryKey,
} from '../../generated/@tanstack/react-query.gen.ts';
import { importYouTubeVideo } from '../../generated/sdk.gen.ts';
import { Imported } from '../../helpers/constants.ts';
import { useGetArtworkUrl } from '../../hooks/useThumbnailUrl.ts';

type ProgrammingTarget = Pick<
  ProgrammingSelectionContextType,
  'entityType' | 'onAddSelectedMedia' | 'onAddMediaSuccess'
>;

type Props = {
  open: boolean;
  onClose: () => void;
  source: Extract<MediaSourceSettings, { type: 'youtube' }>;
  /** Omit for a catalogue-only import. Only explicit Add changes the draft. */
  programming?: ProgrammingTarget;
};

type ImportRequest = {
  controller: AbortController;
  pathname: string;
  sourceId: string;
  entityType?: ProgrammingTarget['entityType'];
  append?: ProgrammingTarget['onAddSelectedMedia'];
};

type Review = { request: ImportRequest; program: ContentProgram };

function isMixedVideoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.searchParams.has('list') &&
      (url.searchParams.has('v') ||
        url.hostname === 'youtu.be' ||
        url.pathname.startsWith('/shorts/') ||
        url.pathname.startsWith('/embed/'))
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
  const queryClient = useQueryClient();
  const getArtworkUrl = useGetArtworkUrl();
  const [url, setUrl] = useState('');
  const [videoOnly, setVideoOnly] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<Review>();
  const [failedArtwork, setFailedArtwork] = useState<string>();
  const [addedId, setAddedId] = useState<string>();
  const addedPrograms = useRef(new Set<string>());
  const active = useRef<ImportRequest | undefined>(undefined);
  const current = useRef({ open, pathname, sourceId: source.id, programming });
  current.current = { open, pathname, sourceId: source.id, programming };
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
  }, [open, pathname, source.id, entityType, append]);

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

  const mixed = isMixedVideoUrl(url.trim());
  const importVideo = async () => {
    if (active.current || !url.trim() || (mixed && !videoOnly)) {
      return;
    }
    const request: ImportRequest = {
      controller: new AbortController(),
      pathname,
      sourceId: source.id,
      entityType,
      append,
    };
    active.current = request;
    setPending(true);
    setReview(undefined);
    setError(undefined);
    try {
      const { data } = await importYouTubeVideo({
        path: { id: source.id },
        body: {
          url: url.trim(),
          ...(mixed ? { intent: 'video' as const } : {}),
        },
        signal: request.controller.signal,
        throwOnError: true,
      });
      if (!isCurrent(request)) {
        return;
      }
      if (data.sourceId !== request.sourceId) {
        throw new Error('Import source changed');
      }
      setReview({ request, program: data.program });
      // Refresh the same catalogue read by the library and programmer.
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: getApiMediaSourcesQueryKey(),
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
      ]).catch(console.error);
    } catch (failure) {
      if (isCurrent(request)) {
        setError(
          typeof failure === 'string'
            ? failure
            : t`Could not import this video. Check the URL and Test setup in Media Sources, then retry. Private, live, playlist and creator imports are not supported here.`,
        );
        setPending(false);
        active.current = undefined;
      }
    } finally {
      if (active.current === request) {
        setPending(false);
      }
    }
  };

  const close = () => {
    invalidate();
    setPending(false);
    setReview(undefined);
    onClose();
  };
  const addToProgramming = () => {
    if (!review || !programming || !isCurrent(review.request)) {
      return;
    }
    const id = review.program.program.uuid;
    if (addedPrograms.current.has(id)) {
      return;
    }
    addedPrograms.current.add(id);
    setAddedId(id);
    programming.onAddSelectedMedia([{ type: Imported, media: review.program }]);
    programming.onAddMediaSuccess();
  };
  const program = review?.program.program;
  const artworkUrl = program
    ? getArtworkUrl(program, ['thumbnail', 'poster'])
    : null;
  const alreadyAdded =
    !!program &&
    (addedId === program.uuid || addedPrograms.current.has(program.uuid));

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="sm"
      aria-labelledby="youtube-import-title"
    >
      <DialogTitle id="youtube-import-title">
        <Trans>Import YouTube video</Trans>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>
            <Trans>
              Import one video into {source.name}. Playlists and creators will
              be supported later.
            </Trans>
          </Typography>
          <Alert severity="info">
            <Trans>
              Only import content you are authorized to use. Import saves
              metadata, not a video download or playback verification. YouTube
              availability is best-effort.
            </Trans>
          </Alert>
          <TextField
            label={t`YouTube video URL`}
            value={url}
            fullWidth
            disabled={pending}
            onChange={(event) => {
              invalidate();
              setUrl(event.target.value);
              setVideoOnly(false);
              setReview(undefined);
              setError(undefined);
            }}
          />
          {mixed && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={videoOnly}
                  disabled={pending}
                  onChange={(_, checked) => setVideoOnly(checked)}
                />
              }
              label={t`Import only this video`}
            />
          )}
          {pending && (
            <LinearProgress aria-label={t`Importing video metadata`} />
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {program && (
            <Stack spacing={1}>
              {artworkUrl && failedArtwork !== artworkUrl ? (
                <Box
                  component="img"
                  src={artworkUrl}
                  alt={program.title}
                  onError={() => setFailedArtwork(artworkUrl)}
                  sx={{ width: '100%', maxHeight: 220, objectFit: 'contain' }}
                />
              ) : (
                <Box sx={{ p: 3, textAlign: 'center' }}>
                  <ImageNotSupported aria-label={t`No artwork available`} />
                </Box>
              )}
              <Typography variant="h6">{program.title}</Typography>
              {program.type === 'other_video' &&
                program.youtubeMetadata?.creatorName && (
                  <Typography>{program.youtubeMetadata.creatorName}</Typography>
                )}
              <Typography>
                <Trans>
                  Duration:{' '}
                  {Math.floor((review?.program.duration ?? 0) / 60000)} min{' '}
                  {Math.floor(((review?.program.duration ?? 0) % 60000) / 1000)}{' '}
                  sec
                </Trans>
              </Typography>
              {'summary' in program && program.summary && (
                <Typography variant="body2">{program.summary}</Typography>
              )}
              <Alert severity="success">
                <Trans>
                  Imported into the library. Playback has not been verified.
                </Trans>
              </Alert>
              <Alert severity="info">
                <Trans>
                  Separate audio/video inputs require transcoding. ErsatzTV
                  playback requires dynamic playout; static windows are not
                  supported. Change incompatible profiles explicitly.
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
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>
          <Trans>Close</Trans>
        </Button>
        {pending ? (
          <Button
            onClick={() => {
              invalidate();
              setPending(false);
              setReview(undefined);
              setError(t`Import cancelled. Your URL was kept. You can retry.`);
            }}
          >
            <Trans>Cancel import</Trans>
          </Button>
        ) : (
          <Button
            disabled={!url.trim() || (mixed && !videoOnly) || !!review}
            onClick={() => {
              void importVideo();
            }}
          >
            {error ? <Trans>Retry</Trans> : <Trans>Import</Trans>}
          </Button>
        )}
        {programming && (
          <Button
            variant="contained"
            disabled={
              !review || pending || alreadyAdded || !isCurrent(review.request)
            }
            onClick={addToProgramming}
          >
            <Trans>Add to programming</Trans>
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
