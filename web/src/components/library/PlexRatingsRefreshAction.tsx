import { Trans, useLingui } from '@lingui/react/macro';
import { StarRate } from '@mui/icons-material';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  getApiMediaSourcesByIdLibrariesByLibraryIdRatingsOptions,
  getApiMediaSourcesQueryKey,
  getApiProgramsRatingsFieldsQueryKey,
  postApiProgramsSearchQueryKey,
} from '../../generated/@tanstack/react-query.gen.ts';
import {
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel,
  postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh,
} from '../../generated/sdk.gen.ts';

export function PlexRatingsRefreshAction({
  mediaSourceId,
  libraryId,
  disabled,
  busy,
}: {
  mediaSourceId: string;
  libraryId: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const terminalJob = useRef<string | undefined>(undefined);
  const path = { id: mediaSourceId, libraryId };
  const options = getApiMediaSourcesByIdLibrariesByLibraryIdRatingsOptions({
    path,
  });
  const status = useQuery({
    ...options,
    enabled: open,
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'in_progress' ? 1000 : false;
    },
  });
  const job = status.data;
  const active = job?.state === 'queued' || job?.state === 'in_progress';
  const checkStatus = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: options.queryKey }),
      queryClient.invalidateQueries({ queryKey: getApiMediaSourcesQueryKey() }),
    ]);
  };
  const refresh = useMutation({
    retry: false,
    onError: checkStatus,
    mutationFn: async () =>
      (
        await postApiMediaSourcesByIdLibrariesByLibraryIdRatingsRefresh({
          path,
          throwOnError: true,
        })
      ).data,
    onSuccess: async (next) => {
      if (next)
        queryClient.setQueryData(
          getApiMediaSourcesByIdLibrariesByLibraryIdRatingsOptions({
            path: { id: next.mediaSourceId, libraryId: next.libraryId },
          }).queryKey,
          next,
        );
      await queryClient.invalidateQueries({
        queryKey: getApiMediaSourcesQueryKey(),
      });
    },
  });
  const cancel = useMutation({
    retry: false,
    onError: checkStatus,
    mutationFn: async (jobId: string) =>
      postApiMediaSourcesByIdLibrariesByLibraryIdRatingsByJobIdCancel({
        path: { ...path, jobId },
        throwOnError: true,
      }),
    onSuccess: async (_response, jobId) => {
      queryClient.setQueryData(options.queryKey, (previous) =>
        previous?.jobId === jobId
          ? { ...previous, cancelRequested: true }
          : previous,
      );
      await queryClient.invalidateQueries({ queryKey: options.queryKey });
    },
  });
  useEffect(() => {
    if (!job || active || terminalJob.current === job.jobId) return;
    terminalJob.current = job.jobId;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: getApiMediaSourcesQueryKey() }),
      queryClient.invalidateQueries({
        queryKey: getApiProgramsRatingsFieldsQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: postApiProgramsSearchQueryKey({ body: { query: {} } }),
      }),
      queryClient.invalidateQueries({ queryKey: ['programs'] }),
    ]).catch(console.error);
  }, [active, job, queryClient]);
  const states = {
    queued: t`Queued`,
    in_progress: t`Refreshing ratings`,
    completed: t`Completed`,
    partial: t`Partial`,
    cancelled: t`Cancelled`,
    failed: t`Failed`,
  };
  const errors = {
    auth: t`Plex authentication failed. Check this source before retrying.`,
    denied: t`Plex denied access to an item. Its previous snapshot was kept.`,
    not_found: t`An existing item was not found in Plex. Its previous snapshot was kept.`,
    timeout: t`A Plex metadata request timed out. Its previous snapshot was kept.`,
    invalid_metadata: t`Plex returned invalid ratings metadata. Its previous snapshot was kept.`,
    source_changed: t`The source or library changed during this job. Retry against the current configuration.`,
    identity_changed: t`An item changed identity during this job. Its previous snapshot was kept.`,
    database: t`A ratings update could not be saved.`,
    index: t`Some search updates were not confirmed. Retry after the existing search index is available.`,
  };
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Tooltip title={t`Plex ratings`}>
        <IconButton
          size="small"
          aria-label={t`Plex ratings`}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <StarRate />
        </IconButton>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
        onClick={(event) => event.stopPropagation()}
        aria-labelledby={`ratings-refresh-${libraryId}`}
      >
        <DialogTitle id={`ratings-refresh-${libraryId}`}>
          <Trans>Plex ratings</Trans>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography>
              <Trans>
                Refresh scores for existing Plex items only. This does not
                discover media, read media files, change channel schedules or
                enable libraries.
              </Trans>
            </Typography>
            <Typography variant="body2">
              <Trans>
                Public and personal scores come from Plex. Omnirating excludes
                personal stars.
              </Trans>
            </Typography>
            {status.isLoading && (
              <LinearProgress aria-label={t`Loading ratings refresh status`} />
            )}
            {status.isError && (
              <Alert
                severity="error"
                action={
                  <Button
                    color="inherit"
                    onClick={() => {
                      void status.refetch();
                    }}
                  >
                    <Trans>Retry</Trans>
                  </Button>
                }
              >
                <Trans>Could not load refresh status.</Trans>
              </Alert>
            )}
            {job ? (
              <>
                <Typography fontWeight="bold">{states[job.state]}</Typography>
                {active && (
                  <LinearProgress
                    aria-label={t`Ratings refresh progress`}
                    variant={
                      job.state === 'queued' ? 'indeterminate' : 'determinate'
                    }
                    value={
                      job.total > 0 ? (100 * job.processed) / job.total : 0
                    }
                  />
                )}
                <Typography variant="body2">
                  <Trans>
                    Processed {job.processed} of {job.total} items. Updated:{' '}
                    {job.refreshed}; unchanged: {job.unchanged}; failed:{' '}
                    {job.failed}; skipped: {job.skipped}; search updates
                    unconfirmed: {job.indexFailed}.
                  </Trans>
                </Typography>
                {active && (
                  <Typography variant="caption">
                    <Trans>
                      Search updates can still be pending after metadata
                      processing reaches 100%.
                    </Trans>
                  </Typography>
                )}
                {job.finishedAt !== null && (
                  <Typography variant="caption">
                    <Trans>
                      Finished: {new Date(job.finishedAt).toLocaleString()}
                    </Trans>
                  </Typography>
                )}
                {job.lastError && (
                  <Alert severity="warning">{errors[job.lastError]}</Alert>
                )}
              </>
            ) : (
              !status.isLoading &&
              !status.isError && (
                <Typography variant="body2">
                  <Trans>
                    No ratings-only job has run in this server session.
                  </Trans>
                </Typography>
              )
            )}
            {(refresh.isError || cancel.isError) && (
              <Alert severity="error">
                <Trans>
                  The request failed or this library is busy. Check its status
                  before retrying.
                </Trans>
              </Alert>
            )}
            {busy && !active && (
              <Typography variant="body2">
                <Trans>
                  The library is busy. Wait for its current operation to finish.
                </Trans>
              </Typography>
            )}
            {disabled && (
              <Typography variant="body2">
                <Trans>
                  Ratings refresh requires an enabled, available Plex library.
                </Trans>
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {active && (
            <Button
              disabled={cancel.isPending || job.cancelRequested}
              onClick={() => {
                refresh.reset();
                cancel.mutate(job.jobId);
              }}
            >
              {job.cancelRequested ? (
                <Trans>Cancelling</Trans>
              ) : (
                <Trans>Cancel refresh</Trans>
              )}
            </Button>
          )}
          <Button
            disabled={
              disabled ||
              busy ||
              active ||
              refresh.isPending ||
              status.isLoading
            }
            onClick={() => {
              cancel.reset();
              refresh.mutate();
            }}
          >
            <Trans>Refresh ratings only</Trans>
          </Button>
          <Button onClick={() => setOpen(false)}>
            <Trans>Close</Trans>
          </Button>
        </DialogActions>
      </Dialog>
    </span>
  );
}
