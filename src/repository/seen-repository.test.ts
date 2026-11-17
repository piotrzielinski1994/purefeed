import { describe, expect, it } from 'vitest';
import { createFakeClock, type FakeClock } from '../../test/helpers/fake-ext.ts';
import { DAY_MS, DEFAULT_THRESHOLDS, flip, HOUR_MS, imageFp, randomHashes, sightingOf } from '../../test/helpers/fingerprints.ts';
import type { Fingerprint } from '../shared/types.ts';
import type { SeenRecord } from './seen-record.ts';
import type { SeenStore } from './seen-store.ts';

const loadRepository = () => import('./seen-repository.ts');
const loadStore = () => import('./seen-store.ts');

const RECORD_FIELDS = [
  'contentType',
  'fingerprint',
  'firstSeenAt',
  'firstSeenPermalink',
  'firstSeenPostKey',
  'lastSeenAt',
  'platform',
  'seenCount',
].sort();

const [A, B, C] = randomHashes(3, 2024);

type Write = { at: number; ids: string[] };

function recordingStore(inner: SeenStore, clock: FakeClock, failWrites = false): { store: SeenStore; writes: Write[] } {
  const writes: Write[] = [];
  const store: SeenStore = {
    loadAll: () => inner.loadAll(),
    write: async (batch) => {
      writes.push({ at: clock.now(), ids: batch.map(([id]) => id) });
      if (failWrites) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      await inner.write(batch);
    },
    deleteIds: (ids) => inner.deleteIds(ids),
    clear: () => inner.clear(),
  };
  return { store, writes };
}

function recordOf(fingerprint: Fingerprint, firstSeenAt: number, lastSeenAt: number): SeenRecord {
  return {
    fingerprint,
    contentType: 'image',
    platform: 'wykop',
    firstSeenPostKey: 'wykop:entry:9',
    firstSeenPermalink: 'https://wykop.pl/wpis/9',
    firstSeenAt,
    lastSeenAt,
    seenCount: 4,
  };
}

type StoreFault = (store: SeenStore) => SeenStore;

async function setup(opts: { seed?: Array<[string, SeenRecord]>; failOpen?: boolean; failWrites?: boolean; fault?: StoreFault } = {}) {
  const { createSeenRepository } = await loadRepository();
  const { createMemorySeenStore } = await loadStore();
  const clock = createFakeClock();
  const inner = createMemorySeenStore();
  if (opts.seed) await inner.write(opts.seed);
  const { store, writes } = recordingStore(inner, clock, opts.failWrites);
  let n = 0;
  const repo = createSeenRepository({
    openStore: opts.failOpen
      ? () => Promise.reject(new DOMException('blocked', 'InvalidStateError'))
      : async () => (opts.fault ?? ((x) => x))(store),
    now: clock.now,
    setTimer: clock.setTimer,
    newId: () => `id-${++n}`,
  });
  return { repo, clock, inner, writes };
}

describe('seen repository records (AC-035, AC-037)', () => {
  it('should persist a new sighting as a record with exactly the 8 fields (TC-049)', async () => {
    const { repo, clock, inner } = await setup();
    await repo.ready;
    const t0 = clock.now();
    const fp = imageFp(A);
    const result = repo.recordSighting(
      sightingOf(fp, { postKey: 'reddit:t3_p1', permalink: 'https://www.reddit.com/r/a/comments/p1/' }),
      DEFAULT_THRESHOLDS,
    );
    expect(result).toEqual({ id: 'id-1', isNew: true });
    await repo.flush();
    const stored = await inner.loadAll();
    expect(stored).toHaveLength(1);
    const [id, record] = stored[0];
    expect(id).toBe('id-1');
    expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
    expect(record).toEqual({
      fingerprint: fp,
      contentType: 'image',
      platform: 'reddit',
      firstSeenPostKey: 'reddit:t3_p1',
      firstSeenPermalink: 'https://www.reddit.com/r/a/comments/p1/',
      firstSeenAt: t0,
      lastSeenAt: t0,
      seenCount: 1,
    });
  });

  it('should update last seen and seen count of the existing record and create no new one if a matching item is seen again (TC-051)', async () => {
    const { repo, clock, inner } = await setup();
    await repo.ready;
    const t0 = clock.now();
    const first = repo.recordSighting(
      sightingOf(imageFp(A), { postKey: 'reddit:t3_p1', permalink: 'https://www.reddit.com/p1' }),
      DEFAULT_THRESHOLDS,
    );
    await clock.advance(60_000);
    const second = repo.recordSighting(
      sightingOf(imageFp(flip(A, 2)), { platform: 'x', postKey: 'x:2', permalink: 'https://x.com/u/status/2' }),
      DEFAULT_THRESHOLDS,
    );
    expect(second).toEqual({ id: first.id, isNew: false });
    await repo.flush();
    const stored = await inner.loadAll();
    expect(stored).toHaveLength(1);
    expect(stored[0][1]).toMatchObject({
      platform: 'reddit',
      firstSeenPostKey: 'reddit:t3_p1',
      firstSeenPermalink: 'https://www.reddit.com/p1',
      firstSeenAt: t0,
      lastSeenAt: t0 + 60_000,
      seenCount: 2,
    });
  });

  it('should update the existing record if the new sighting is only a near match', async () => {
    const { repo } = await setup();
    await repo.ready;
    const first = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    const second = repo.recordSighting(sightingOf(imageFp(flip(A, 5)), { postKey: 'reddit:t3_other' }), DEFAULT_THRESHOLDS);
    expect(second).toEqual({ id: first.id, isNew: false });
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.record.seenCount).toBe(2);
  });

  it('should create a second record if the new sighting does not match', async () => {
    const { repo, inner } = await setup();
    await repo.ready;
    repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    const other = repo.recordSighting(sightingOf(imageFp(B), { postKey: 'reddit:t3_b' }), DEFAULT_THRESHOLDS);
    expect(other).toEqual({ id: 'id-2', isNew: true });
    await repo.flush();
    expect(await inner.loadAll()).toHaveLength(2);
  });

  it('should match a recorded item in lookup before the record is written', async () => {
    const { repo, writes } = await setup();
    await repo.ready;
    const { id } = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    const match = repo.lookup(imageFp(flip(A, 1)), DEFAULT_THRESHOLDS);
    expect(writes).toHaveLength(0);
    expect(match).toMatchObject({ id, comparison: { matchClass: 'exact' } });
    expect(repo.lookup(imageFp(C), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should match stored records after ready if the store already holds records', async () => {
    const t = Date.UTC(2026, 10, 10);
    const { repo, inner } = await setup({ seed: [['stored-1', recordOf(imageFp(A), t, t)]] });
    await repo.ready;
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)).toMatchObject({ id: 'stored-1', record: { seenCount: 4 } });
    expect(repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS)).toEqual({ id: 'stored-1', isNew: false });
    await repo.flush();
    expect((await inner.loadAll())[0][1].seenCount).toBe(5);
  });
});

describe('seen repository write queue (AC-039)', () => {
  it('should write at most 1 batch per second and each queued record within 2 s if sightings arrive every 100 ms for 60 s (TC-055)', async () => {
    const { repo, clock, inner, writes } = await setup();
    await repo.ready;
    const start = clock.now();
    const hashes = randomHashes(600, 7);
    const queuedAt = new Map<string, number>();
    for (const [i, hash] of hashes.entries()) {
      const { id, isNew } = repo.recordSighting(sightingOf(imageFp(hash), { postKey: `reddit:t3_${i}` }), DEFAULT_THRESHOLDS);
      expect(isNew).toBe(true);
      queuedAt.set(id, clock.now());
      await clock.advance(100);
    }
    await clock.advance(2000);
    expect(writes.filter((w) => w.at < start + 60_000).length).toBeLessThanOrEqual(60);
    for (let k = 1; k < writes.length; k++) {
      expect(writes[k].at - writes[k - 1].at).toBeGreaterThanOrEqual(1000);
    }
    for (const [id, at] of queuedAt) {
      const written = writes.find((w) => w.at >= at && w.ids.includes(id));
      expect(written, `record ${id} queued at +${at - start} ms`).toBeDefined();
      expect((written?.at ?? Number.POSITIVE_INFINITY) - at).toBeLessThanOrEqual(2000);
    }
    expect(await inner.loadAll()).toHaveLength(600);
  });

  it('should write a queued update within 2 s if an existing record is seen again', async () => {
    const { repo, clock, inner } = await setup();
    await repo.ready;
    repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    await clock.advance(5000);
    repo.recordSighting(sightingOf(imageFp(A), { postKey: 'reddit:t3_again' }), DEFAULT_THRESHOLDS);
    await clock.advance(2000);
    expect((await inner.loadAll())[0][1].seenCount).toBe(2);
  });

  it('should write all queued records at once if flush runs', async () => {
    const { repo, inner, writes } = await setup();
    await repo.ready;
    repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    repo.recordSighting(sightingOf(imageFp(B), { postKey: 'reddit:t3_b' }), DEFAULT_THRESHOLDS);
    await repo.flush();
    expect(writes).toHaveLength(1);
    expect(await inner.loadAll()).toHaveLength(2);
  });
});

describe('seen repository retention purge (AC-038)', () => {
  it('should delete only the record older than 7 days if retention is 7 days (TC-052)', async () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const keep = recordOf(imageFp(A), now - 10 * DAY_MS, now - (7 * DAY_MS - HOUR_MS));
    const drop = recordOf(imageFp(B), now - 10 * DAY_MS, now - (7 * DAY_MS + HOUR_MS));
    const { repo, clock, inner } = await setup({
      seed: [
        ['keep', keep],
        ['drop', drop],
      ],
    });
    clock.set(now);
    await repo.ready;
    expect(await repo.purge(7)).toBe(1);
    await repo.flush();
    expect((await inner.loadAll()).map(([id]) => id)).toEqual(['keep']);
    expect(repo.lookup(imageFp(B), DEFAULT_THRESHOLDS)).toBeNull();
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.id).toBe('keep');
  });

  it('should delete 31-day-old records if retention is 30 days (TC-053)', async () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const { repo, clock, inner } = await setup({ seed: [['old', recordOf(imageFp(A), now - 31 * DAY_MS, now - 31 * DAY_MS)]] });
    clock.set(now);
    await repo.ready;
    expect(await repo.purge(30)).toBe(1);
    await repo.flush();
    expect(await inner.loadAll()).toEqual([]);
  });

  it('should delete nothing if retention is forever (TC-054)', async () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const { repo, clock, inner } = await setup({ seed: [['ancient', recordOf(imageFp(A), now - 400 * DAY_MS, now - 400 * DAY_MS)]] });
    clock.set(now);
    await repo.ready;
    expect(await repo.purge(null)).toBe(0);
    await repo.flush();
    expect(await inner.loadAll()).toHaveLength(1);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.id).toBe('ancient');
  });
});

describe('seen repository clear and failures (AC-040, AC-041)', () => {
  it('should delete all records and leave nothing queued if clear runs (TC-057)', async () => {
    const t = Date.UTC(2026, 10, 10);
    const { repo, clock, inner } = await setup({ seed: [['stored', recordOf(imageFp(A), t, t)]] });
    await repo.ready;
    repo.recordSighting(sightingOf(imageFp(B)), DEFAULT_THRESHOLDS);
    await repo.clear();
    await clock.advance(3000);
    expect(await inner.loadAll()).toEqual([]);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)).toBeNull();
    expect(repo.lookup(imageFp(B), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should report persisted and keep matching in memory if the store fails to open (TC-056)', async () => {
    const { repo } = await setup({ failOpen: true });
    await expect(repo.ready).resolves.toBeUndefined();
    expect(repo.persisted()).toBe(false);
    const first = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    expect(repo.lookup(imageFp(flip(A, 1)), DEFAULT_THRESHOLDS)?.id).toBe(first.id);
    expect(repo.recordSighting(sightingOf(imageFp(A), { postKey: 'reddit:t3_2' }), DEFAULT_THRESHOLDS)).toEqual({ id: first.id, isNew: false });
    await expect(repo.flush()).resolves.toBeUndefined();
  });

  it('should switch persisted to false and keep matching in memory if a write fails', async () => {
    const { repo, clock } = await setup({ failWrites: true });
    await repo.ready;
    expect(repo.persisted()).toBe(true);
    const { id } = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    await clock.advance(2000);
    expect(repo.persisted()).toBe(false);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.id).toBe(id);
  });
});

describe('seen repository store faults (AC-040)', () => {
  const closedConnection = () => new DOMException('The database connection is closing.', 'InvalidStateError');

  it('should keep matching in memory and never write if loading the stored records fails', async () => {
    const { repo, clock, writes } = await setup({ fault: (store) => ({ ...store, loadAll: () => Promise.reject(closedConnection()) }) });
    await expect(repo.ready).resolves.toBeUndefined();
    expect(repo.persisted()).toBe(false);
    const { id } = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    await clock.advance(2000);
    expect(writes).toEqual([]);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.id).toBe(id);
  });

  it('should switch persisted to false and keep matching if the store throws at once on write', async () => {
    const { repo, clock } = await setup({
      fault: (store) => ({
        ...store,
        write: () => {
          throw closedConnection();
        },
      }),
    });
    await repo.ready;
    const { id } = repo.recordSighting(sightingOf(imageFp(A)), DEFAULT_THRESHOLDS);
    await clock.advance(2000);
    expect(repo.persisted()).toBe(false);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)?.id).toBe(id);
  });

  it('should still drop expired records from memory and switch persisted to false if deleting them from the store fails', async () => {
    const t = createFakeClock().now();
    const seed: Array<[string, SeenRecord]> = [['old', recordOf(imageFp(A), t - 40 * DAY_MS, t - 40 * DAY_MS)]];
    const { repo } = await setup({ seed, fault: (store) => ({ ...store, deleteIds: () => Promise.reject(closedConnection()) }) });
    await repo.ready;
    expect(await repo.purge(30)).toBe(1);
    expect(repo.persisted()).toBe(false);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should empty the memory index and switch persisted to false if clearing the store fails', async () => {
    const t = createFakeClock().now();
    const { repo } = await setup({
      seed: [['a', recordOf(imageFp(A), t, t)]],
      fault: (store) => ({ ...store, clear: () => Promise.reject(closedConnection()) }),
    });
    await repo.ready;
    await expect(repo.clear()).resolves.toBeUndefined();
    expect(repo.persisted()).toBe(false);
    expect(repo.lookup(imageFp(A), DEFAULT_THRESHOLDS)).toBeNull();
  });
});
