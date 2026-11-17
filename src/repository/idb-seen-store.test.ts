import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { imageFp, posterFp, randomHashes, sequenceFp } from '../../test/helpers/fingerprints.ts';
import type { SeenRecord } from './seen-record.ts';

const loadIdb = () => import('./idb-seen-store.ts');

const T0 = Date.UTC(2026, 10, 1);
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

const [H1, H2] = randomHashes(2, 77);

const RECORD: SeenRecord = {
  fingerprint: imageFp(H1),
  contentType: 'image',
  platform: 'reddit',
  firstSeenPostKey: 'reddit:t3_abc',
  firstSeenPermalink: 'https://www.reddit.com/r/memes/comments/abc/x/',
  firstSeenAt: T0,
  lastSeenAt: T0 + 1000,
  seenCount: 3,
};

function openRaw(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open('purefeed') : factory.open('purefeed', version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('seen', 'readonly').objectStore('seen').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('IndexedDB seen store (AC-035, AC-036, AC-040)', () => {
  it('should store a value with exactly the 8 record fields under the record id key if a record is written', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const factory = new IDBFactory();
    const store = await openIdbSeenStore(factory);
    await store.write([['rec-1', RECORD]]);
    const db = await openRaw(factory);
    const value = (await rawGet(db, 'rec-1')) as Record<string, unknown>;
    db.close();
    expect(Object.keys(value).sort()).toEqual(RECORD_FIELDS);
    expect(value).toEqual(RECORD);
  });

  it('should create database purefeed v2 with out-of-line keyed store seen and index lastSeenAt if opened', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const factory = new IDBFactory();
    await openIdbSeenStore(factory);
    const db = await openRaw(factory);
    const tx = db.transaction('seen', 'readonly');
    const store = tx.objectStore('seen');
    const facts = { version: db.version, keyPath: store.keyPath, hasLastSeenIndex: store.indexNames.contains('lastSeenAt') };
    db.close();
    expect(facts).toEqual({ version: 2, keyPath: null, hasLastSeenIndex: true });
  });

  it('should load the written records of every fingerprint kind if the database is opened again in a new browser session', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const factory = new IDBFactory();
    const first = await openIdbSeenStore(factory);
    const sequence: SeenRecord = { ...RECORD, fingerprint: sequenceFp(randomHashes(8, 9), 12.5), contentType: 'gif' };
    const poster: SeenRecord = { ...RECORD, fingerprint: posterFp(H2), contentType: 'video', platform: 'x' };
    await first.write([
      ['rec-1', RECORD],
      ['rec-2', sequence],
      ['rec-3', poster],
    ]);
    const second = await openIdbSeenStore(factory);
    const loaded = new Map(await second.loadAll());
    expect(loaded.size).toBe(3);
    expect(loaded.get('rec-1')).toEqual(RECORD);
    expect(loaded.get('rec-2')).toEqual(sequence);
    expect(loaded.get('rec-3')).toEqual(poster);
    expect(loaded.get('rec-2')?.fingerprint).toMatchObject({ frames: expect.any(Uint32Array), timestamps: expect.any(Float32Array) });
  });

  it('should reject, not throw, and keep the stored records if a record cannot be cloned into the store', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const store = await openIdbSeenStore(new IDBFactory());
    await store.write([['kept', RECORD]]);
    const uncloneable = { ...RECORD, firstSeenPermalink: () => 'no' } as unknown as SeenRecord;
    const result = (() => {
      try {
        return { written: store.write([['bad', uncloneable]]) };
      } catch (error) {
        return { thrown: error };
      }
    })();
    expect(result).not.toHaveProperty('thrown');
    await expect(result.written).rejects.toMatchObject({ name: 'DataCloneError' });
    expect((await store.loadAll()).map(([id]) => id)).toEqual(['kept']);
  });

  it('should drop only the image records if a database written by the previous edge map version is opened', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const factory = new IDBFactory();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('purefeed', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('seen');
        store.createIndex('lastSeenAt', 'lastSeenAt');
        store.put(RECORD, 'old-image');
        store.put({ ...RECORD, fingerprint: posterFp(H2), contentType: 'video' }, 'old-poster');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    const store = await openIdbSeenStore(factory);
    expect((await store.loadAll()).map(([id]) => id)).toEqual(['old-poster']);
  });

  it('should reject if the database cannot be opened', async () => {
    const { openIdbSeenStore } = await loadIdb();
    const factory = new IDBFactory();
    const newer = await openRaw(factory, 3);
    newer.close();
    await expect(openIdbSeenStore(factory)).rejects.toBeDefined();
  });
});
