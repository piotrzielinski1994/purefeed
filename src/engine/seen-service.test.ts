import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../../test/helpers/fake-ext.ts';
import { flip, imageFp, randomHashes, sightingOf } from '../../test/helpers/fingerprints.ts';
import type { SeenRecord } from '../repository/seen-record.ts';
import type { SeenStore } from '../repository/seen-store.ts';
import type { CounterValues, Settings } from '../shared/types.ts';

const loadService = () => import('./seen-service.ts');
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

const [A, B] = randomHashes(2, 5150);

function countersStub() {
  const values: CounterValues = { duplicatesHidden: 0, uniqueItems: 0 };
  return {
    ready: Promise.resolve(),
    get: () => ({ ...values }),
    addHidden: () => void values.duplicatesHidden++,
    addUnique: () => void values.uniqueItems++,
    reset: async () => {
      values.duplicatesHidden = 0;
      values.uniqueItems = 0;
    },
  };
}

async function setup(opts: { settings?: Partial<Settings>; openStore?: () => Promise<SeenStore> } = {}) {
  const { createSeenService } = await loadService();
  const { createSeenRepository } = await loadRepository();
  const { createMemorySeenStore } = await loadStore();
  const clock = createFakeClock();
  const store = createMemorySeenStore();
  const repository = createSeenRepository({
    openStore: opts.openStore ?? (async () => store),
    now: clock.now,
    setTimer: clock.setTimer,
    newId: () => crypto.randomUUID(),
  });
  const current = { ...BASE, ...opts.settings };
  const settings = { get: () => current, onChange: () => () => {} };
  const counters = countersStub();
  const service = createSeenService({ repository, settings, counters });
  return { service, counters, clock };
}

describe('seen service (AC-007, AC-061)', () => {
  it('should return a seen match per fingerprint in order and null for unseen ones', async () => {
    const { service, clock } = await setup();
    const t0 = clock.now();
    const { recordId } = await service.record(
      sightingOf(imageFp(A), { platform: 'wykop', postKey: 'wykop:entry:7', permalink: 'https://wykop.pl/wpis/7' }),
    );
    const matches = await service.lookup([imageFp(B), imageFp(flip(A, 2))]);
    expect(matches).toEqual([
      null,
      {
        recordId,
        matchClass: 'exact',
        platform: 'wykop',
        firstSeenPostKey: 'wykop:entry:7',
        firstSeenPermalink: 'https://wykop.pl/wpis/7',
        firstSeenAt: t0,
      },
    ]);
  });

  it('should classify with the thresholds of the current settings', async () => {
    const { service } = await setup({ settings: { exactThreshold: 100, nearThreshold: 97 } });
    await service.record(sightingOf(imageFp(A)));
    const [oneBit, threeBits] = await service.lookup([imageFp(flip(A, 1)), imageFp(flip(A, 3))]);
    expect(oneBit?.matchClass).toBe('near');
    expect(threeBits).toBeNull();
  });

  it('should add 1 unique item per new record and nothing for a repeated sighting (TC-061)', async () => {
    const { service, counters } = await setup();
    const first = await service.record(sightingOf(imageFp(A)));
    const repeat = await service.record(sightingOf(imageFp(A), { postKey: 'reddit:t3_again' }));
    const second = await service.record(sightingOf(imageFp(B), { postKey: 'reddit:t3_b' }));
    expect([first.isNew, repeat.isNew, second.isNew]).toEqual([true, false, true]);
    expect(repeat.recordId).toBe(first.recordId);
    expect(counters.get()).toEqual({ duplicatesHidden: 0, uniqueItems: 2 });
  });

  it('should answer a lookup sent before stored records finish loading with the stored match (AC-007)', async () => {
    const { createMemorySeenStore } = await loadStore();
    const seeded = createMemorySeenStore();
    const t = Date.UTC(2026, 10, 1);
    const record: SeenRecord = {
      fingerprint: imageFp(A),
      contentType: 'image',
      platform: 'x',
      firstSeenPostKey: 'x:42',
      firstSeenPermalink: 'https://x.com/u/status/42',
      firstSeenAt: t,
      lastSeenAt: t,
      seenCount: 1,
    };
    await seeded.write([['stored-42', record]]);
    let open: (store: SeenStore) => void = () => {};
    const opened = new Promise<SeenStore>((resolve) => {
      open = resolve;
    });
    const { service } = await setup({ openStore: () => opened });
    const pending = service.lookup([imageFp(A)]);
    setTimeout(() => open(seeded), 20);
    expect(await pending).toEqual([
      {
        recordId: 'stored-42',
        matchClass: 'exact',
        platform: 'x',
        firstSeenPostKey: 'x:42',
        firstSeenPermalink: 'https://x.com/u/status/42',
        firstSeenAt: t,
      },
    ]);
  });
});
