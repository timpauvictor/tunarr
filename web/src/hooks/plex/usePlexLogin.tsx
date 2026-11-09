import {
  getApiMediaSourcesOptions,
  getApiMediaSourcesQueryKey,
  postApiMediaSourcesMutation,
} from '@/generated/@tanstack/react-query.gen.ts';
import {
  discoverPlexServers,
  type PlexDiscoveryOutcome,
} from '@/helpers/plexDiscovery.ts';
import { plexLoginFlow } from '@/helpers/plexLogin.ts';
import { t } from '@lingui/core/macro';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { isNonEmptyString } from '@tunarr/shared/util';
import { useSnackbar, type SnackbarKey } from 'notistack';
import { useEffect, useRef } from 'react';

const mutationKey = ['plex-auto-add'];

function outcomeLabel(status: PlexDiscoveryOutcome['status']) {
  return {
    added: t`Added`,
    already_present: t`Already present`,
    unreachable: t`Unreachable; check the server address and network`,
    missing_token: t`Skipped: no access token`,
    missing_identity: t`Skipped: missing server identity; use manual setup`,
    probe_failed: t`Connection check failed; check access and network`,
    add_failed: t`Save failed or response lost; refresh before retrying`,
    cancelled: t`Cancelled`,
  }[status];
}

function summary(outcomes: PlexDiscoveryOutcome[]) {
  const count = (status: PlexDiscoveryOutcome['status']) =>
    outcomes.filter((o) => o.status === status).length;
  const added = count('added');
  const present = count('already_present');
  const skipped =
    count('missing_token') + count('missing_identity') + count('cancelled');
  const failed =
    count('unreachable') + count('probe_failed') + count('add_failed');
  return t`Plex: ${added} added, ${present} already present, ${skipped} skipped, ${failed} failed.`;
}

function resultsMessage(outcomes: PlexDiscoveryOutcome[]) {
  return (
    <>
      {outcomes.length === 0
        ? t`No Plex servers were returned. Try manual setup.`
        : summary(outcomes)}
      <div>
        {outcomes.map((o) => `${o.name}: ${outcomeLabel(o.status)}`).join('; ')}
      </div>
    </>
  );
}

export const usePlexLogin = () => {
  const queryClient = useQueryClient();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const owner = useRef<AbortController | null>(null);
  const notice = useRef<SnackbarKey | null>(null);
  const isPending = useIsMutating({ mutationKey }) > 0;
  const add = useMutation({ ...postApiMediaSourcesMutation(), retry: false });
  const discovery = useMutation({
    mutationKey,
    retry: false,
    mutationFn: async () => {
      const run = new AbortController();
      owner.current = run;
      const signal = run.signal;
      const current = () => owner.current === run && !signal.aborted;
      const show = (message: React.ReactNode, persist: boolean) => {
        if (!current()) {
          return;
        }
        if (notice.current !== null) {
          closeSnackbar(notice.current);
        }
        notice.current = enqueueSnackbar({
          message,
          persist,
          variant: 'info',
          autoHideDuration: 15_000,
        });
      };
      let stage = 'sign-in';
      try {
        show(t`Signing in to Plex…`, true);
        const servers = await plexLoginFlow();
        if (!current()) {
          return;
        }
        stage = 'sources';
        // Force a fresh read, especially after a previous POST's response was lost.
        const sources = await queryClient.fetchQuery({
          ...getApiMediaSourcesOptions(),
          staleTime: 0,
        });
        if (!current()) {
          return;
        }
        const existingIds = new Set(
          sources.flatMap((s) =>
            s.type === 'plex' && isNonEmptyString(s.clientIdentifier)
              ? [s.clientIdentifier]
              : [],
          ),
        );
        stage = 'discovery';
        show(
          t`Checking Plex servers; reachable servers will appear as they are saved…`,
          true,
        );
        const outcomes = await discoverPlexServers(servers, {
          signal,
          existingIds,
          onReachable: async (server, connection) => {
            if (!current()) {
              throw new Error('Discovery cancelled before saving');
            }
            await add.mutateAsync({
              body: {
                name: server.name,
                uri: connection.uri,
                accessToken: server.accessToken ?? '',
                clientIdentifier: server.clientIdentifier,
                userId: null,
                username: null,
                type: 'plex',
                pathReplacements: [],
              },
            });
            // A committed POST stays added even if its follow-up refresh fails.
            await queryClient
              .invalidateQueries({
                queryKey: getApiMediaSourcesQueryKey(),
              })
              .catch(() => {});
          },
          onOutcome: (outcomes) => show(resultsMessage(outcomes), true),
        });
        show(resultsMessage(outcomes), false);
      } catch {
        show(
          stage === 'sign-in'
            ? t`Plex sign-in failed or was cancelled. Please try again.`
            : stage === 'sources'
              ? t`Could not refresh saved sources. No servers were added; retry when the server is reachable.`
              : t`Plex discovery failed. Saved sources are preserved; refresh before retrying.`,
          false,
        );
      } finally {
        if (current()) {
          owner.current = null;
        }
      }
    },
  });
  useEffect(
    () => () => {
      owner.current?.abort();
      if (notice.current !== null) {
        closeSnackbar(notice.current);
      }
    },
    [closeSnackbar],
  );

  return {
    isPending,
    startDiscovery: () => {
      // Mutation-cache admission is synchronous and shared by both entrypoints.
      if (queryClient.isMutating({ mutationKey }) === 0) {
        discovery.mutate();
      }
    },
  };
};
