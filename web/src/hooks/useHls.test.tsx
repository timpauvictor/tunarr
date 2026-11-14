import { act, renderHook } from '@testing-library/react';
import type * as HlsModule from 'hls.js';
import { StrictMode, useEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { hlsFixture, latestHlsPlayer } from '../test/hlsFixture.ts';
import { useHls } from './useHls.ts';

vi.mock('hls.js', async (importOriginal) => {
  const original = await importOriginal<typeof HlsModule>();
  const { createHlsFixture } = await import('../test/hlsFixture.ts');
  return { ...original, default: createHlsFixture(original.default) };
});

beforeEach(() => {
  hlsFixture.players.length = 0;
  hlsFixture.supported = true;
});

test('preserves startup defaults and releases replaced and unmounted players once', () => {
  const { result, unmount } = renderHook(() => useHls());
  act(() => {
    result.current.resetHls();
  });
  const first = latestHlsPlayer();
  expect(first.config.manifestLoadPolicy?.default.maxLoadTimeMs).toBe(60000);
  expect(
    first.config.manifestLoadPolicy?.default.maxTimeToFirstByteMs,
  ).toBeDefined();
  expect(first.config.fragLoadingTimeOut).toBe(30000);
  expect(first.config.initialLiveManifestSize).toBe(3);
  act(() => {
    result.current.resetHls();
  });
  const second = latestHlsPlayer();
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(second.destroy).not.toHaveBeenCalled();
  unmount();
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(second.destroy).toHaveBeenCalledOnce();
});

test('keeps caller overrides and does not recreate or dispose on an inline-config rerender', () => {
  const { result, rerender, unmount } = renderHook(() =>
    useHls({ startPosition: 0, fragLoadingTimeOut: 12345 }),
  );
  act(() => {
    result.current.resetHls();
  });
  const player = latestHlsPlayer();
  expect(player.config.startPosition).toBe(0);
  expect(player.config.fragLoadingTimeOut).toBe(12345);
  rerender();
  expect(hlsFixture.players).toHaveLength(1);
  expect(player.destroy).not.toHaveBeenCalled();
  unmount();
  expect(player.destroy).toHaveBeenCalledOnce();
});

test('supports effect setup-cleanup-setup and idempotent disposal in Strict Mode', () => {
  const { result, unmount } = renderHook(
    () => {
      const player = useHls();
      useEffect(() => {
        player.resetHls();
      }, [player.resetHls]);
      return player;
    },
    { wrapper: StrictMode },
  );
  expect(hlsFixture.players).toHaveLength(2);
  const first = hlsFixture.players[0];
  const current = latestHlsPlayer();
  expect(first?.destroy).toHaveBeenCalledOnce();
  expect(current.destroy).not.toHaveBeenCalled();
  act(() => {
    result.current.disposeHls();
    result.current.disposeHls();
  });
  expect(current.destroy).toHaveBeenCalledOnce();
  act(() => {
    current.emitError({ fatal: true });
  });
  expect(result.current.fatalError).toBe(false);
  unmount();
  expect(current.destroy).toHaveBeenCalledOnce();
});

test('leaves nonfatal recovery to HLS and ignores stale errors after replacement', () => {
  const { result } = renderHook(() => useHls());
  act(() => {
    result.current.resetHls();
  });
  const first = latestHlsPlayer();
  act(() => {
    first.emitError({ fatal: false });
  });
  expect(result.current.fatalError).toBe(false);
  expect(first.destroy).not.toHaveBeenCalled();
  act(() => {
    result.current.resetHls();
  });
  const current = latestHlsPlayer();
  act(() => {
    first.emitError({ fatal: true });
  });
  expect(result.current.fatalError).toBe(false);
  expect(current.destroy).not.toHaveBeenCalled();
});

test('stops the failed owner and clears terminal state only when explicitly reset', () => {
  const { result } = renderHook(() => useHls());
  act(() => {
    result.current.resetHls();
  });
  const player = latestHlsPlayer();
  act(() => {
    player.emitError({
      fatal: true,
      url: 'https://private.invalid/?token=secret',
    });
  });
  expect(player.destroy).toHaveBeenCalledOnce();
  expect(result.current.fatalError).toBe(true);
  expect(hlsFixture.players).toHaveLength(1);
  act(() => {
    result.current.resetHls();
  });
  expect(result.current.fatalError).toBe(false);
  expect(hlsFixture.players).toHaveLength(2);
});

test('does not acquire players for unsupported browsers or late callbacks after unmount', () => {
  const { result, unmount } = renderHook(() => useHls());
  hlsFixture.supported = false;
  act(() => {
    expect(result.current.resetHls()).toBeUndefined();
  });
  expect(hlsFixture.players).toHaveLength(0);
  hlsFixture.supported = true;
  const reset = result.current.resetHls;
  unmount();
  act(() => {
    expect(reset()).toBeUndefined();
  });
  expect(hlsFixture.players).toHaveLength(0);
});
