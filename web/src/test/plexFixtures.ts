import type { PlexResource } from '@tunarr/types/plex';

export function plexServer(
  id: string,
  overrides: Partial<PlexResource> = {},
): PlexResource {
  return {
    clientIdentifier: id,
    name: id,
    accessToken: 'RECOGNIZABLE_FAKE_TOKEN',
    connections: [true, false].map((local) => ({
      IPv6: false,
      address: id,
      local,
      port: 32400,
      protocol: 'https',
      relay: false,
      uri: `https://${id}-${local ? 'local' : 'remote'}.example:32400`,
    })),
    createdAt: '',
    device: '',
    home: false,
    httpsRequired: false,
    lastSeenAt: '',
    owned: true,
    platform: '',
    platformVersion: '',
    presence: true,
    product: '',
    productVersion: '',
    provides: 'server',
    publicAddress: '',
    publicAddressMatches: false,
    relay: false,
    sourceTitle: null,
    synced: false,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
