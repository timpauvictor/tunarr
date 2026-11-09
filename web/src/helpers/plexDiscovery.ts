import { postApiMediaSourcesForeignstatus } from '@/generated/sdk.gen.ts';
import { isNonEmptyString } from '@tunarr/shared/util';
import type { PlexConnection, PlexResource } from '@tunarr/types/plex';

export type PlexDiscoveryOutcome = {
  name: string;
  status:
    | 'added'
    | 'already_present'
    | 'unreachable'
    | 'missing_token'
    | 'missing_identity'
    | 'probe_failed'
    | 'add_failed'
    | 'cancelled';
};

function candidates(connections: PlexConnection[]) {
  const seen = new Set<string>();
  const groups = [true, false].map((local) =>
    connections
      .filter((connection) => connection.local === local)
      .sort(
        (a, b) =>
          Number(b.protocol === 'https') - Number(a.protocol === 'https'),
      ),
  );
  const ordered: PlexConnection[] = [];
  for (let i = 0; i < Math.max(...groups.map((group) => group.length)); i++) {
    for (const group of groups) {
      const connection = group[i];
      if (!connection) {
        continue;
      }
      try {
        const uri = new URL(connection.uri).href;
        if (!seen.has(uri)) {
          seen.add(uri);
          ordered.push(connection);
        }
      } catch {
        /* Invalid candidates never reach the transport. */
      }
    }
  }
  return ordered;
}

export async function discoverPlexServers(
  servers: PlexResource[],
  options: {
    signal: AbortSignal;
    existingIds: ReadonlySet<string>;
    onReachable: (
      server: PlexResource,
      connection: PlexConnection,
    ) => Promise<void>;
    onOutcome: (outcomes: PlexDiscoveryOutcome[]) => void;
  },
) {
  const outcomes: PlexDiscoveryOutcome[] = [];
  const report = (
    server: PlexResource,
    status: PlexDiscoveryOutcome['status'],
  ) => {
    const outcome = { name: server.name, status };
    outcomes.push(outcome);
    options.onOutcome([...outcomes]);
  };
  const unique = new Map<string, PlexResource>();
  for (const server of servers) {
    if (!isNonEmptyString(server.clientIdentifier)) {
      report(server, 'missing_identity');
      continue;
    }
    if (!isNonEmptyString(unique.get(server.clientIdentifier)?.accessToken)) {
      unique.set(server.clientIdentifier, server);
    }
  }
  const queue = unique.values();
  const saves: Promise<void>[] = [];
  const worker = async () => {
    for (const server of queue) {
      if (options.signal.aborted) {
        report(server, 'cancelled');
        continue;
      }
      if (options.existingIds.has(server.clientIdentifier)) {
        report(server, 'already_present');
        continue;
      }
      if (!isNonEmptyString(server.accessToken)) {
        report(server, 'missing_token');
        continue;
      }
      const accessToken = server.accessToken;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, options.signal]);
      const timer = setTimeout(() => controller.abort(), 15_000);
      const connections = candidates(server.connections);
      let candidate = 0;
      let won = false;
      let threw = false;
      const probe = async () => {
        while (!signal.aborted && candidate < connections.length) {
          const connection = connections[candidate++];
          if (!connection) {
            return;
          }
          const request = new AbortController();
          const requestTimer = setTimeout(() => request.abort(), 7_000);
          try {
            const { data } = await postApiMediaSourcesForeignstatus({
              body: {
                name: server.name,
                accessToken,
                uri: connection.uri,
                type: 'plex',
              },
              signal: AbortSignal.any([signal, request.signal]),
              timeout: 7_000,
              throwOnError: true,
            });
            if (data.healthy !== true || signal.aborted || won) {
              continue;
            }
            // Claim before any await; losing endpoints cannot submit another POST.
            won = true;
            controller.abort();
            // Saves are independent of probe workers: a slow POST cannot block discovery.
            saves.push(
              Promise.resolve()
                .then(() => options.onReachable(server, connection))
                .then(
                  () => report(server, 'added'),
                  () => report(server, 'add_failed'),
                ),
            );
          } catch {
            if (!signal.aborted) {
              threw = true;
            }
          } finally {
            clearTimeout(requestTimer);
          }
        }
      };
      try {
        await Promise.all([probe(), probe()]);
        if (!won) {
          report(
            server,
            options.signal.aborted
              ? 'cancelled'
              : threw
                ? 'probe_failed'
                : 'unreachable',
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.size) }, worker));
  await Promise.all(saves);
  return outcomes;
}
