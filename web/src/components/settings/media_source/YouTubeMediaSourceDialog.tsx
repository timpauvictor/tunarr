import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { MediaSourceSettings } from '@tunarr/types';
import { useEffect, useRef, useState } from 'react';
import { getYouTubeHealth } from '../../../generated/sdk.gen.ts';
import {
  useCreateMediaSource,
  useUpdateMediaSource,
} from '../../../hooks/media-sources/mediaSourceHooks.ts';

type Props = {
  open: boolean;
  onClose: () => void;
  source?: Extract<MediaSourceSettings, { type: 'youtube' }>;
};

type Health = Awaited<ReturnType<typeof getYouTubeHealth>>['data'];

function YouTubeMediaSourceForm({ onClose, source }: Omit<Props, 'open'>) {
  const { t } = useLingui();
  const [name, setName] = useState(source?.name ?? 'YouTube');
  const [health, setHealth] = useState<Health>();
  const [testing, setTesting] = useState(false);
  const [testFailed, setTestFailed] = useState(false);
  const testRequest = useRef<AbortController | undefined>(undefined);
  const create = useCreateMediaSource();
  const update = useUpdateMediaSource();
  const saving = create.isPending || update.isPending;

  useEffect(() => () => testRequest.current?.abort(), []);

  const testSetup = async () => {
    if (testRequest.current) {
      return;
    }
    const controller = new AbortController();
    testRequest.current = controller;
    setTesting(true);
    setTestFailed(false);
    setHealth(undefined);
    try {
      const { data } = await getYouTubeHealth({
        signal: controller.signal,
        throwOnError: true,
      });
      if (!controller.signal.aborted) {
        setHealth(data);
      }
    } catch {
      if (!controller.signal.aborted) {
        setTestFailed(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        setTesting(false);
        testRequest.current = undefined;
      }
    }
  };

  const save = () => {
    if (!name.trim() || saving) {
      return;
    }
    const body = {
      name: name.trim(),
      type: 'youtube' as const,
      pathReplacements: [],
    };
    if (source) {
      update.mutate(
        { path: { id: source.id }, body: { ...body, id: source.id } },
        { onSuccess: onClose },
      );
    } else {
      create.mutate({ body }, { onSuccess: onClose });
    }
  };

  return (
    <>
      <DialogTitle id="youtube-source-title">
        {source ? t`Edit YouTube source` : t`New YouTube source`}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label={t`Name`}
            autoFocus
            value={name}
            required
            fullWidth
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
          <Alert severity="info">
            <Trans>
              Use only content you are authorized to use. YouTube is a
              best-effort source and may stop working when upstream access
              changes. Tunarr reuses its Node runtime (Node 22 or later); the
              server needs the pinned yt-dlp companion. Account cookies, private
              or paid videos, DRM and running livestreams are not supported.
            </Trans>
          </Alert>
          <Typography variant="body2">
            <Trans>
              Test setup checks the server tools only. It does not play a video
              or verify playback. Individual imports appear in Saved Videos.
            </Trans>
          </Typography>
          <Button
            onClick={() => {
              void testSetup();
            }}
            disabled={testing || saving}
          >
            <Trans>Test setup</Trans>
          </Button>
          {testing && <LinearProgress aria-label={t`Testing YouTube setup`} />}
          {health && (
            <Alert severity={health.available ? 'success' : 'warning'}>
              {health.available ? (
                <Trans>
                  YouTube extractor and Node runtime are ready. Playback has not
                  been verified.
                </Trans>
              ) : (
                <Trans>
                  YouTube tools are unavailable. Reinstall the companions, or
                  run pnpm download-youtube in server/ for a source checkout,
                  then retry Test setup.
                </Trans>
              )}
              {!health.available && (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {health.message}
                </Typography>
              )}
              {health.extractorVersion && (
                <Typography variant="body2">
                  <Trans>yt-dlp version: {health.extractorVersion}</Trans>
                </Typography>
              )}
            </Alert>
          )}
          {testFailed && (
            <Alert severity="error">
              <Trans>
                Could not test setup. Check the server connection and retry.
              </Trans>
            </Alert>
          )}
          {(create.isError || update.isError) && (
            <Alert severity="error">
              <Trans>
                Could not save the source. Your name was kept; retry when the
                server is available.
              </Trans>
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={!name.trim() || saving}
        >
          <Trans>Save</Trans>
        </Button>
      </DialogActions>
    </>
  );
}

export function YouTubeMediaSourceDialog({ open, onClose, source }: Props) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="youtube-source-title"
    >
      {open && (
        <YouTubeMediaSourceForm
          key={source?.id ?? 'new'}
          onClose={onClose}
          source={source}
        />
      )}
    </Dialog>
  );
}
