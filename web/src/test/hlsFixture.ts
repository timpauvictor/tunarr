import type { ErrorData, Events, HlsConfig } from 'hls.js';
import type Hls from 'hls.js';
import { vi } from 'vitest';

export const hlsFixture = {
  supported: true,
  players: [] as FixtureHls[],
};

class FixtureHls {
  readonly on =
    vi.fn<
      (
        event: Events,
        listener: (event: Events, data: Partial<ErrorData>) => void,
      ) => void
    >();
  readonly loadSource = vi.fn<(url: string) => void>();
  readonly attachMedia = vi.fn<(media: HTMLMediaElement) => void>();
  readonly detachMedia = vi.fn();
  readonly destroy = vi.fn();

  constructor(
    readonly config: Partial<HlsConfig>,
    private readonly errorEvent: Events,
  ) {
    hlsFixture.players.push(this);
  }

  emitError(data: Partial<ErrorData>) {
    for (const [event, listener] of this.on.mock.calls) {
      if (event === this.errorEvent) listener(event, data);
    }
  }
}

export function createHlsFixture(original: typeof Hls) {
  return class extends FixtureHls {
    constructor(config: Partial<HlsConfig>) {
      super(config, original.Events.ERROR);
    }
    static isSupported = () => hlsFixture.supported;
    static DefaultConfig = original.DefaultConfig;
    static Events = original.Events;
  };
}

export function latestHlsPlayer() {
  const player = hlsFixture.players.at(-1);
  if (!player) throw new Error('Expected an owned HLS player.');
  return player;
}
