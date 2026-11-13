import { act, renderHook } from '@testing-library/react';
import type { HlsConfig } from 'hls.js';
import type * as HlsModule from 'hls.js';
import { expect, test, vi } from 'vitest';
import { useHls } from './useHls.ts';

const boundary = vi.hoisted(() => ({
  configs: [] as Partial<HlsConfig>[],
  destroy: vi.fn(),
}));

vi.mock('hls.js', async (importOriginal) => {
  const original = await importOriginal<typeof HlsModule>();
  class FixtureHls {
    static isSupported = () => true;
    static DefaultConfig = original.default.DefaultConfig;
    static Events = original.default.Events;
    on = vi.fn();
    destroy = boundary.destroy;
    constructor(config: Partial<HlsConfig>) {
      boundary.configs.push(config);
    }
  }
  return { ...original, default: FixtureHls };
});

test('allows the bounded server startup window and destroys the replaced player', () => {
  const { result, unmount } = renderHook(() => useHls());
  act(() => {
    result.current.resetHls();
  });
  const config = boundary.configs[0];
  expect(config?.manifestLoadPolicy?.default.maxLoadTimeMs).toBe(60000);
  expect(
    config?.manifestLoadPolicy?.default.maxTimeToFirstByteMs,
  ).toBeDefined();
  expect(config?.fragLoadingTimeOut).toBe(30000);
  expect(config?.initialLiveManifestSize).toBe(3);
  act(() => {
    result.current.resetHls();
  });
  expect(boundary.destroy).toHaveBeenCalledOnce();
  unmount();
});
