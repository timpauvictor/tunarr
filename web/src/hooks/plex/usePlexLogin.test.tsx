import AddPlexServer from '@/components/settings/AddPlexServer.tsx';
import { AddMediaSourceButton } from '@/components/settings/media_source/AddMediaSourceButton.tsx';
import { getApiMediaSourcesOptions } from '@/generated/@tanstack/react-query.gen.ts';
import { deferred, plexServer } from '@/test/plexFixtures.ts';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SnackbarProvider } from 'notistack';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlexLogin } from './usePlexLogin.tsx';

const { login, probe, getSources, postSource } = vi.hoisted(() => ({
  login: vi.fn(),
  probe: vi.fn(),
  getSources: vi.fn(),
  postSource: vi.fn(),
}));
vi.mock('@/helpers/plexLogin.ts', () => ({ plexLoginFlow: login }));
vi.mock('@/generated/sdk.gen.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  postApiMediaSourcesForeignstatus: probe,
  getApiMediaSources: getSources,
  postApiMediaSources: postSource,
}));

let sources: {
  id: string;
  name: string;
  type: 'plex';
  clientIdentifier: string;
}[];
let client: QueryClient;
function Owner({ label }: { label: string }) {
  const { startDiscovery, isPending } = usePlexLogin();
  return (
    <button onClick={startDiscovery} disabled={isPending}>
      {isPending ? `${label} pending` : label}
    </button>
  );
}
function SourceList() {
  const { data = [] } = useQuery(getApiMediaSourcesOptions());
  return (
    <ul>
      {data.map((source) => (
        <li key={source.id}>{source.name}</li>
      ))}
    </ul>
  );
}
function Wrapper({ children }: PropsWithChildren) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SnackbarProvider maxSnack={1} TransitionProps={{ timeout: 0 }}>
          {children}
        </SnackbarProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  sources = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  login.mockResolvedValue([plexServer('good')]);
  getSources.mockImplementation(async () => ({ data: [...sources] }));
  probe.mockResolvedValue({ data: { healthy: true } });
  postSource.mockImplementation(async ({ body }) => {
    sources.push({ ...body, id: body.clientIdentifier });
    return { data: { id: body.clientIdentifier } };
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe('Plex auto-add integration', () => {
  it.each(['button', 'menu'])(
    'adds through the actual %s entrypoint and preserves manual options',
    async (entry) => {
      render(
        <>
          {entry === 'button' ? (
            <AddPlexServer title="Auto add" />
          ) : (
            <AddMediaSourceButton />
          )}
          <SourceList />
        </>,
        { wrapper: Wrapper },
      );
      if (entry === 'button')
        fireEvent.click(screen.getByRole('button', { name: 'Auto add' }));
      else {
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Plex (Auto)' }));
      }
      await waitFor(() =>
        expect(screen.getByRole('listitem')).toHaveTextContent('good'),
      );
      expect(postSource).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(client.isMutating({ mutationKey: ['plex-auto-add'] })).toBe(0),
      );
      if (entry === 'menu') {
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        for (const name of ['Plex (Manual)', 'Jellyfin', 'Emby', 'Local'])
          expect(screen.getByRole('menuitem', { name })).toBeEnabled();
        fireEvent.click(
          screen.getByRole('menuitem', { name: 'Plex (Manual)' }),
        );
        expect(await screen.findByText('New Plex Server')).toBeVisible();
      }
    },
  );
  it('displays a saved source while one server hangs and a third throws, and prevents overlapping owners', async () => {
    const hanging = deferred<{ data: { healthy: boolean } }>();
    login.mockResolvedValue(
      ['hang', 'good', 'throws'].map((id) => plexServer(id)),
    );
    probe.mockImplementation(async ({ body }) => {
      if (body.name === 'hang') return hanging.promise;
      if (body.name === 'throws') throw new Error('RECOGNIZABLE_FAKE_TOKEN');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { data: { healthy: true } };
    });
    render(
      <>
        <Owner label="First" />
        <Owner label="Second" />
        <SourceList />
      </>,
      { wrapper: Wrapper },
    );
    const refresh = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    fireEvent.click(screen.getByRole('button', { name: /Second/ }));
    await waitFor(() =>
      expect(screen.getByRole('listitem')).toHaveTextContent('good'),
    );
    expect(login).toHaveBeenCalledTimes(1);
    expect(postSource).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(client.isMutating({ mutationKey: ['plex-auto-add'] })).toBe(1);
    expect(
      screen.getByRole('button', { name: 'Second pending' }),
    ).toBeDisabled();
    expect(document.body.textContent).not.toContain('RECOGNIZABLE_FAKE_TOKEN');
    await act(async () => {
      hanging.resolve({ data: { healthy: false } });
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          /Plex: 1 added, 0 already present, 0 skipped, 2 failed/,
        ),
      ).toBeVisible(),
    );
  });

  it('reconciles fresh identities before retry after an uncertain save, without automatic retries', async () => {
    postSource.mockImplementationOnce(async ({ body }) => {
      sources.push({ ...body, id: body.clientIdentifier });
      throw new Error('RECOGNIZABLE_FAKE_TOKEN response lost');
    });
    render(<Owner label="Add" />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          /Plex: 0 added, 0 already present, 0 skipped, 1 failed/,
        ),
      ).toBeVisible(),
    );
    expect(screen.getByText(/Save failed or response lost/)).toBeVisible();
    expect(document.body.textContent).not.toContain('RECOGNIZABLE_FAKE_TOKEN');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByText(/0 added, 1 already present/)).toBeVisible(),
    );
    expect(postSource).toHaveBeenCalledTimes(1);
    expect(getSources).toHaveBeenCalledTimes(2);
  });

  it('shows sign-in, empty-result and existing-source-read failures without writes', async () => {
    login.mockRejectedValueOnce(new Error('RECOGNIZABLE_FAKE_TOKEN'));
    render(<Owner label="Add" />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByText(/Plex sign-in failed/)).toBeVisible(),
    );
    login.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByText(/No Plex servers were returned/)).toBeVisible(),
    );
    getSources.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByText(/Could not refresh saved sources/)).toBeVisible(),
    );
    expect(postSource).not.toHaveBeenCalled();
  });

  it('aborts owned probes on teardown but lets a submitted source POST settle and refresh', async () => {
    const post = deferred<{ data: { id: string } }>();
    postSource.mockReturnValue(post.promise);
    login.mockResolvedValue([plexServer('good'), plexServer('hang')]);
    const hangingSignals: AbortSignal[] = [];
    probe.mockImplementation(async ({ body, signal }) => {
      if (body.name === 'good') return { data: { healthy: true } };
      hangingSignals.push(signal);
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
    });
    const view = render(<Owner label="Add" />, { wrapper: Wrapper });
    const refresh = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(postSource).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(hangingSignals).toHaveLength(2);
    expect(hangingSignals.every((signal) => signal.aborted)).toBe(true);
    expect(postSource.mock.calls[0]?.[0].signal).toBeUndefined();
    await act(async () => {
      post.resolve({ data: { id: 'good' } });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain('Plex:');
  });
});
