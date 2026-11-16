import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeExt, settle } from '../../test/helpers/fake-ext.ts';
import { DAY_MS, HOUR_MS, imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import type { SeenRecord } from '../repository/seen-record.ts';
import type { RetentionDays, Settings } from '../shared/types.ts';

const loadRetention = () => import('./retention.ts');
const loadRepository = () => import('../repository/seen-repository.ts');
const loadStore = () => import('../repository/seen-store.ts');

const BASE: Settings = {
  enabled: true,
  mode: 'exact-near',
  exactThreshold: 95,
  nearThreshold: 90,
  retentionDays: 30,
  platforms: { reddit: true, wykop: true, x: true },
  contentTypes: { image: true, gif: true, video: true },
  toast: true,
};

const HASHES = randomHashes(4, 909);

function settingsStub(retentionDays: RetentionDays) {
  let current: Settings = { ...BASE, retentionDays };
  const listeners = new Set<(next: Settings, prev: Settings) => void>();
  return {
    get: () => current,
    onChange(cb: (next: Settings, prev: Settings) => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    change(patch: Partial<Settings>) {
      const prev = current;
      current = { ...current, ...patch };
      for (const cb of listeners) cb(current, prev);
    },
  };
}

function recordAged(i: number, now: number, ageMs: number): [string, SeenRecord] {
  const at = now - ageMs;
  return [
    `rec-${i}`,
    {
      fingerprint: imageFp(HASHES[i]),
      contentType: 'image',
      platform: 'reddit',
      firstSeenPostKey: `reddit:t3_${i}`,
      firstSeenPermalink: `https://www.reddit.com/comments/${i}/`,
      firstSeenAt: at,
      lastSeenAt: at,
      seenCount: 1,
    },
  ];
}

async function setup(retentionDays: RetentionDays, ages: number[]) {
  const { startRetention } = await loadRetention();
  const { createSeenRepository } = await loadRepository();
  const { createMemorySeenStore } = await loadStore();
  const clock = createFakeClock();
  const ext = createFakeExt();
  const store = createMemorySeenStore();
  await store.write(ages.map((age, i) => recordAged(i, clock.now(), age)));
  const repository = createSeenRepository({
    openStore: async () => store,
    now: clock.now,
    setTimer: clock.setTimer,
    newId: () => crypto.randomUUID(),
  });
  const settings = settingsStub(retentionDays);
  const start = () => startRetention({ repository, settings, alarms: ext.alarms, setTimer: clock.setTimer });
  const ids = async () => {
    await repository.flush();
    return (await store.loadAll()).map(([id]) => id).sort();
  };
  return { start, clock, ext, settings, ids };
}

describe('retention (AC-038)', () => {
  it('should delete only the record older than 7 days at background start if retention is 7 days (TC-052)', async () => {
    const { start, ids } = await setup(7, [7 * DAY_MS - HOUR_MS, 7 * DAY_MS + HOUR_MS]);
    start();
    await settle();
    expect(await ids()).toEqual(['rec-0']);
  });

  it('should register the purefeed-purge alarm every 1440 minutes', async () => {
    const { start, ext } = await setup(30, []);
    start();
    await settle();
    expect(ext.alarms.created.get('purefeed-purge')).toMatchObject({ periodInMinutes: 1440 });
  });

  it('should delete records that aged past the retention period if the 24 h alarm fires', async () => {
    const { start, clock, ext, ids } = await setup(30, [29 * DAY_MS, 10 * DAY_MS]);
    start();
    await settle();
    expect(await ids()).toEqual(['rec-0', 'rec-1']);
    clock.set(clock.now() + 2 * DAY_MS);
    ext.alarms.fire('purefeed-purge');
    await settle();
    expect(await ids()).toEqual(['rec-1']);
  });

  it('should delete 31-day-old records within 5 s if retention changes from forever to 30 days (TC-053)', async () => {
    const { start, clock, settings, ids } = await setup(null, [31 * DAY_MS, 31 * DAY_MS, 2 * DAY_MS]);
    start();
    await settle();
    expect(await ids()).toEqual(['rec-0', 'rec-1', 'rec-2']);
    settings.change({ retentionDays: 30 });
    await clock.advance(5000);
    expect(await ids()).toEqual(['rec-2']);
  });

  it('should delete nothing if retention is forever and the 24 h alarm fires on 400-day-old records (TC-054)', async () => {
    const { start, ext, ids } = await setup(null, [400 * DAY_MS, 400 * DAY_MS]);
    start();
    await settle();
    ext.alarms.fire('purefeed-purge');
    await settle();
    expect(await ids()).toEqual(['rec-0', 'rec-1']);
  });
});
