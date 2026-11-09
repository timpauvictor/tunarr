import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlexResource } from '@tunarr/types/plex';
import { deferred, plexServer } from '@/test/plexFixtures.ts';
import { discoverPlexServers } from './plexDiscovery.ts';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@/generated/sdk.gen.ts', () => ({
  postApiMediaSourcesForeignstatus: probe,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function pending(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), {
      once: true,
    });
  });
}

function run(
  servers = [plexServer('healthy')],
  existingIds = new Set<string>(),
) {
  const controller = new AbortController();
  const save = vi.fn(async () => {});
  const report = vi.fn();
  const promise = discoverPlexServers(servers, {
    signal: controller.signal,
    existingIds,
    onReachable: save,
    onOutcome: report,
  });
  return { controller, save, report, promise };
}

describe('bounded incremental Plex discovery', () => {
  it('saves B while A still hangs and C throws; slow saves do not hold probe workers', async () => {
    vi.useFakeTimers();
    const saveGate = deferred<void>();
    probe.mockImplementation(async ({ body, signal }) => {
      if (body.name === 'hang') return pending(signal);
      if (body.name === 'throws') throw new Error('RECOGNIZABLE_FAKE_TOKEN');
      return { data: { healthy: true } };
    });
    const controller = new AbortController();
    const save = vi.fn((_server: PlexResource) => saveGate.promise);
    const report = vi.fn();
    let finished = false;
    const promise = discoverPlexServers(
      ['hang', 'good', 'throws', 'four', 'five'].map((id) => plexServer(id)),
      {
        signal: controller.signal,
        existingIds: new Set(),
        onReachable: save,
        onOutcome: report,
      },
    ).then((results) => {
      finished = true;
      return results;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(save.mock.calls.map(([server]) => server.name)).toEqual(
      expect.arrayContaining(['good', 'five']),
    );
    expect(finished).toBe(false);
    saveGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith(
      expect.arrayContaining([{ name: 'good', status: 'added' }]),
    );
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(7_000);
    const results = await promise;
    expect(results).toContainEqual({ name: 'throws', status: 'probe_failed' });
    expect(JSON.stringify(results)).not.toContain('RECOGNIZABLE_FAKE_TOKEN');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits probes to four servers / two endpoints, cancels losers and deduplicates', async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const byName = new Map<string, number>();
    probe.mockImplementation(async ({ body, signal }) => {
      active++;
      peak = Math.max(peak, active);
      byName.set(body.name, (byName.get(body.name) ?? 0) + 1);
      expect(byName.get(body.name)).toBeLessThanOrEqual(2);
      try {
        return await pending(signal);
      } finally {
        active--;
        byName.set(body.name, (byName.get(body.name) ?? 1) - 1);
      }
    });
    const r = run(Array.from({ length: 9 }, (_, i) => plexServer(String(i))));
    expect(peak).toBe(8);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(await r.promise).toHaveLength(9);
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    probe.mockResolvedValue({ data: { healthy: true } });
    const d = run(
      [plexServer('same'), plexServer('same'), plexServer('existing')],
      new Set(['existing']),
    );
    expect(await d.promise).toEqual(
      expect.arrayContaining([
        { name: 'same', status: 'added' },
        { name: 'existing', status: 'already_present' },
      ]),
    );
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls.every(([options]) => options.signal.aborted)).toBe(
      true,
    );
  });

  it('tries fallback after exceptions, deduplicates URI candidates and isolates add failure', async () => {
    probe
      .mockRejectedValueOnce(new Error('HTTP 401'))
      .mockResolvedValue({ data: { healthy: true } });
    const r = run();
    await r.promise;
    expect(r.save).toHaveBeenCalledTimes(1);
    const server = plexServer('failed-save');
    const connection = server.connections[0];
    if (!connection) throw new Error('Fixture has no connection');
    server.connections = [
      connection,
      { ...connection, uri: connection.uri + '/' },
    ];
    const save = vi.fn(async () => {
      throw new Error('response lost');
    });
    expect(
      await discoverPlexServers([server], {
        signal: new AbortController().signal,
        existingIds: new Set(),
        onReachable: save,
        onOutcome: vi.fn(),
      }),
    ).toEqual([{ name: 'failed-save', status: 'add_failed' }]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('enforces a fifteen-second active-server budget across multiple request deadlines', async () => {
    vi.useFakeTimers();
    probe.mockImplementation(({ signal }) => pending(signal));
    const server = plexServer('budget');
    server.connections = Array.from({ length: 8 }, (_, i) => ({
      ...plexServer('budget').connections[0],
      IPv6: false,
      address: 'budget',
      local: true,
      port: 32400,
      protocol: 'https',
      relay: false,
      uri: `https://budget-${i}.example`,
    }));
    let finished = false;
    const r = run([server]);
    void r.promise.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await r.promise).toEqual([
      { name: 'budget', status: 'probe_failed' },
    ]);
    expect(probe).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports missing metadata, invalid/unhealthy responses, cancellation and empty lists', async () => {
    probe.mockResolvedValue({
      data: { healthy: false, status: 'bad_response' },
    });
    const r = run([
      plexServer('no-token', { accessToken: null }),
      plexServer('no-id', { clientIdentifier: '' }),
      plexServer('bad'),
    ]);
    expect(await r.promise).toEqual(
      expect.arrayContaining([
        { name: 'no-token', status: 'missing_token' },
        { name: 'no-id', status: 'missing_identity' },
        { name: 'bad', status: 'unreachable' },
      ]),
    );
    expect(await run([]).promise).toEqual([]);
    probe.mockImplementation(({ signal }) => pending(signal));
    const cancelled = run();
    cancelled.controller.abort();
    expect(await cancelled.promise).toEqual([
      { name: 'healthy', status: 'cancelled' },
    ]);
    expect(cancelled.save).not.toHaveBeenCalled();
  });
});
