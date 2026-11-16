import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeExt, type FakeExt } from '../../test/helpers/fake-ext.ts';

const loadCounters = () => import('./counters.ts');

async function setup(ext: FakeExt = createFakeExt()) {
  const { createCounters } = await loadCounters();
  const clock = createFakeClock();
  const setTimes: number[] = [];
  const storage = {
    get: ext.storage.local.get,
    set: (items: Record<string, unknown>) => {
      setTimes.push(clock.now());
      return ext.storage.local.set(items);
    },
  };
  const counters = createCounters({ storage, now: clock.now, setTimer: clock.setTimer });
  await counters.ready;
  return { counters, clock, ext, setTimes };
}

describe('counters (AC-036, AC-041, AC-061, AC-064)', () => {
  it('should start at 0 and add 1 per call to the matching counter (TC-061)', async () => {
    const { counters } = await setup();
    expect(counters.get()).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
    counters.addHidden();
    counters.addUnique();
    counters.addUnique();
    expect(counters.get()).toEqual({ duplicatesHidden: 1, uniqueItems: 2 });
  });

  it('should write counters to storage.local at most once per second and leave storage.sync untouched (TC-084)', async () => {
    const { counters, clock, ext, setTimes } = await setup();
    for (let i = 0; i < 100; i++) {
      counters.addHidden();
      await clock.advance(10);
    }
    await clock.advance(1000);
    expect(setTimes.length).toBeGreaterThan(0);
    for (let k = 1; k < setTimes.length; k++) {
      expect(setTimes[k] - setTimes[k - 1]).toBeGreaterThanOrEqual(1000);
    }
    expect(ext.storage.local.dump().counters).toEqual({ duplicatesHidden: 100, uniqueItems: 0 });
    expect(ext.storage.sync.dump()).toEqual({});
  });

  it('should keep the counter values if new counters start after a browser restart (TC-036)', async () => {
    const first = await setup();
    first.counters.addHidden();
    first.counters.addHidden();
    first.counters.addUnique();
    await first.clock.advance(1000);
    const second = await setup(first.ext.restart());
    expect(second.counters.get()).toEqual({ duplicatesHidden: 2, uniqueItems: 1 });
    second.counters.addUnique();
    await second.clock.advance(1000);
    expect(second.ext.storage.local.dump().counters).toEqual({ duplicatesHidden: 2, uniqueItems: 2 });
  });

  it('should set both counters to 0 in memory and storage and not restore them later if reset runs (TC-058)', async () => {
    const { counters, clock, ext } = await setup();
    counters.addHidden();
    counters.addUnique();
    await clock.advance(1000);
    counters.addHidden();
    await counters.reset();
    expect(counters.get()).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
    expect(ext.storage.local.dump().counters).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
    await clock.advance(3000);
    expect(ext.storage.local.dump().counters).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
  });
});
