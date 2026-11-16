import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { imageFp, randomHashes, sequenceFp } from '../../test/helpers/fingerprints.ts';
import type { Fingerprint } from '../shared/types.ts';
import type { SeenRecord } from './seen-record.ts';
import type { SeenStore } from './seen-store.ts';

const T0 = Date.UTC(2026, 10, 1);

function recordOf(fingerprint: Fingerprint, lastSeenAt = T0): SeenRecord {
  return {
    fingerprint,
    contentType: fingerprint.kind === 'image' ? 'image' : 'video',
    platform: 'wykop',
    firstSeenPostKey: 'wykop:entry:1',
    firstSeenPermalink: 'https://wykop.pl/wpis/1',
    firstSeenAt: T0,
    lastSeenAt,
    seenCount: 1,
  };
}

const sortById = (entries: Array<[string, SeenRecord]>) => [...entries].sort(([a], [b]) => a.localeCompare(b));

const STORES: Array<[string, () => Promise<SeenStore>]> = [
  ['memory', async () => (await import('./seen-store.ts')).createMemorySeenStore()],
  ['IndexedDB', async () => (await import('./idb-seen-store.ts')).openIdbSeenStore(new IDBFactory())],
];

const [H1, H2, H3] = randomHashes(3, 41);

describe.each(STORES)('%s seen store contract', (_name, open) => {
  it('should return every written record with its fingerprint if loadAll runs after write', async () => {
    const store = await open();
    const a = recordOf(imageFp(H1));
    const b = recordOf(sequenceFp(randomHashes(8, 3), 20));
    await store.write([
      ['a', a],
      ['b', b],
    ]);
    expect(sortById(await store.loadAll())).toEqual([
      ['a', a],
      ['b', b],
    ]);
  });

  it('should replace the record and keep 1 entry if the same id is written again', async () => {
    const store = await open();
    await store.write([['a', recordOf(imageFp(H1))]]);
    const updated = { ...recordOf(imageFp(H1), T0 + 5000), seenCount: 2 };
    await store.write([['a', updated]]);
    expect(await store.loadAll()).toEqual([['a', updated]]);
  });

  it('should keep the other records if deleteIds removes some ids', async () => {
    const store = await open();
    await store.write([
      ['a', recordOf(imageFp(H1))],
      ['b', recordOf(imageFp(H2))],
      ['c', recordOf(imageFp(H3))],
    ]);
    await store.deleteIds(['a', 'c']);
    expect((await store.loadAll()).map(([id]) => id)).toEqual(['b']);
  });

  it('should hold 0 records if clear runs (AC-041)', async () => {
    const store = await open();
    await store.write([
      ['a', recordOf(imageFp(H1))],
      ['b', recordOf(imageFp(H2))],
    ]);
    await store.clear();
    expect(await store.loadAll()).toEqual([]);
  });
});
