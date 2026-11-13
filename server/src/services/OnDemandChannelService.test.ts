import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import { KEYS } from '@/types/inject.js';
import { MutexMap } from '@/util/mutexMap.js';
import { Container } from 'inversify';
import { anything, instance, mock, when } from 'ts-mockito';
import { LineupSchema } from '../db/derived_types/Lineup.ts';
import type { OnDemandChannelConfig } from '../db/derived_types/Lineup.ts';
import type { Channel } from '../db/schema/Channel.ts';
import { GlobalScheduler } from './Scheduler.ts';
import { setTestGlobalOptions } from '../testing/getFakeSettingsDb.ts';
import { OnDemandChannelService } from './OnDemandChannelService.ts';

beforeAll(async () => {
  await setTestGlobalOptions();
});

// Mirrors the production container: autobind on, no defaultScope. Inversify's
// default scope is Transient, so an @injectable class that is never explicitly
// bound is resolved fresh at every injection site.
function containerLikeProduction() {
  const container = new Container({ autobind: true });
  container.bind<MutexMap>(KEYS.MutexMap).toDynamicValue(() => new MutexMap());
  container.bind<IChannelDB>(KEYS.ChannelDB).toConstantValue({} as IChannelDB);
  return container;
}

// The service guards every read-modify-write of a channel's onDemandConfig with
// a per-channel lock from #locks. That only serializes anything if every
// consumer shares one instance -- otherwise each holds a private MutexMap and
// locks a channel only against itself. It has three injection sites:
// ServerContext, OnDemandChannelStateTask, and the HlsSession factory in
// StreamModule.
test('resolves to one shared instance so its per-channel locks serialize', () => {
  const container = containerLikeProduction();

  const first = container.get(OnDemandChannelService);
  const second = container.get(OnDemandChannelService);

  expect(first).toBe(second);
});

test('pause-on-idle persists the mixed-lineup cursor across idle and service restart rather than advancing wall clock', async () => {
  vi.useFakeTimers();
  const scheduler = vi
    .spyOn(GlobalScheduler, 'scheduleOneOffTask')
    .mockImplementation(() => {});
  const start = Date.UTC(2026, 0, 1);
  const channel: Channel = {
    uuid: 'mixed-channel',
    startTime: start - 3600000,
    duration: 120000,
    number: 1,
    name: 'Mixed source channel',
    createdAt: null,
    updatedAt: null,
    disableFillerOverlay: 0,
    fillerRepeatCooldown: null,
    groupTitle: null,
    guideFlexTitle: null,
    guideMinimumDuration: 0,
    icon: { path: '', width: 0, duration: 0, position: 'top-left' },
    offline: { mode: 'pic' },
    stealth: 0,
    streamMode: 'hls',
    streamSelectionProfileId: null,
    subtitlesEnabled: 0,
    transcodeConfigId: 'profile',
    transcoding: null,
    useEtvNext: 0,
    watermark: null,
  };
  const lineup = LineupSchema.parse({
    version: 7,
    lastUpdated: start - 1000,
    startTimeOffsets: [0, 60000],
    items: [
      { type: 'content', id: 'youtube-video', durationMs: 60000 },
      { type: 'content', id: 'plex-video', durationMs: 60000 },
    ],
    onDemandConfig: { state: 'playing', cursor: 45000, lastResumed: start },
  });
  const itemsBefore = structuredClone(lineup.items);
  const db = mock<IChannelDB>();
  when(db.loadChannelAndLineup(channel.uuid)).thenCall(async () => ({
    channel,
    lineup,
  }));
  when(
    db.updateLineupConfig(channel.uuid, 'onDemandConfig', anything()),
  ).thenCall(
    async (_id: string, _key: string, config: OnDemandChannelConfig) => {
      lineup.onDemandConfig = { ...config };
    },
  );
  try {
    const service = new OnDemandChannelService(new MutexMap(), instance(db));
    await service.pauseChannel(channel.uuid, start + 17000);
    expect(lineup.onDemandConfig).toMatchObject({
      state: 'paused',
      cursor: 62000,
      lastPaused: start + 17000,
    });
    const restarted = new OnDemandChannelService(new MutexMap(), instance(db));
    expect(await restarted.isChannelPlaying(channel.uuid)).toBe(false);
    vi.setSystemTime(start + 3600000);
    await restarted.resumeChannel(channel.uuid);
    expect(
      await restarted.getLiveTimestamp(channel.uuid, start + 3600000),
    ).toBe(channel.startTime + 62000);
    expect(
      await restarted.getLiveTimestamp(channel.uuid, start + 3605000),
    ).toBe(channel.startTime + 67000);
    expect(lineup.items).toEqual(itemsBefore);
    expect(channel.startTime).toBe(start - 3600000);
    expect(lineup.onDemandConfig).toMatchObject({
      state: 'playing',
      cursor: 62000,
      lastResumed: start + 3600000,
    });
  } finally {
    scheduler.mockRestore();
    vi.useRealTimers();
  }
});
