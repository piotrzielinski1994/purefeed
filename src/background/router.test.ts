import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeExt, type FakeExt } from '../../test/helpers/fake-ext.ts';
import { flip, imageFp, randomHashes, sightingOf } from '../../test/helpers/fingerprints.ts';
import type { Request } from '../shared/messages.ts';
import type { Settings, WhitelistEntry } from '../shared/types.ts';
import { encodeFingerprint, encodeSighting } from '../shared/wire.ts';

const SENDER = { tabId: 3, url: 'https://www.reddit.com/' };
const [A, B, C] = randomHashes(3, 8080);

async function boot(opts: { ext?: FakeExt; factory?: IDBFactory } = {}) {
  const [{ createRouter }, { createSeenService }, { createCounters }, { createWhitelistStore }, { createSettingsSource }, repo, idb] =
    await Promise.all([
      import('./router.ts'),
      import('../engine/seen-service.ts'),
      import('../engine/counters.ts'),
      import('../engine/whitelist-store.ts'),
      import('../shared/settings.ts'),
      import('../repository/seen-repository.ts'),
      import('../repository/idb-seen-store.ts'),
    ]);
  const ext = opts.ext ?? createFakeExt();
  const factory = opts.factory ?? new IDBFactory();
  const clock = createFakeClock();
  const settings = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
  const counters = createCounters({ storage: ext.storage.local, now: clock.now, setTimer: clock.setTimer });
  const whitelist = createWhitelistStore({ storage: ext.storage.local });
  await Promise.all([settings.ready, counters.ready, whitelist.ready]);
  const repository = repo.createSeenRepository({
    openStore: () => idb.openIdbSeenStore(factory),
    now: clock.now,
    setTimer: clock.setTimer,
    newId: () => crypto.randomUUID(),
  });
  const seen = createSeenService({ repository, settings, counters });
  const logs: string[] = [];
  const router = createRouter({ seen, counters, whitelist, repository, log: (m: string) => logs.push(m) });
  const send = (req: Request) => router(req, SENDER);
  return { send, ext, factory, clock, repository, whitelist, settings, logs };
}

const lookup = (...hashes: Array<[number, number]>): Request => ({
  type: 'seen/lookup',
  fingerprints: hashes.map((h) => encodeFingerprint(imageFp(h))),
});
const record = (hash: [number, number], postKey = 'reddit:t3_a'): Request => ({
  type: 'seen/record',
  sighting: encodeSighting(sightingOf(imageFp(hash), { postKey })),
});

describe('background router (AC-007, AC-036, AC-040, AC-041, AC-061, AC-064)', () => {
  it('should answer seen/lookup with the match of an earlier seen/record and null for unseen media', async () => {
    const bg = await boot();
    const recorded = await bg.send(record(A));
    expect(recorded).toEqual({ recordId: expect.any(String), isNew: true });
    const { recordId } = recorded as { recordId: string };
    const response = await bg.send(lookup(flip(A, 2), B));
    expect(response).toEqual({
      matches: [
        {
          recordId,
          matchClass: 'exact',
          platform: 'reddit',
          firstSeenPostKey: 'reddit:t3_a',
          firstSeenPermalink: 'https://www.reddit.com/r/memes/comments/abc/x/',
          firstSeenAt: bg.clock.now(),
        },
        null,
      ],
    });
  });

  it('should still match stored records if a new router starts over the same IndexedDB after the background stops (TC-007)', async () => {
    const first = await boot();
    const { recordId } = (await first.send(record(A))) as { recordId: string };
    await first.repository.flush();
    const second = await boot({ ext: first.ext.restart(), factory: first.factory });
    const response = (await second.send(lookup(flip(A, 1)))) as { matches: Array<{ recordId: string } | null> };
    expect(response.matches[0]?.recordId).toBe(recordId);
  });

  it('should keep records, settings, whitelist and counters if the browser restarts (TC-036)', async () => {
    const first = await boot();
    const entry: WhitelistEntry = { type: 'source', key: 'reddit:r/memes' };
    await first.send(record(A));
    await first.send({ type: 'stats/hidden' });
    await first.send({ type: 'stats/hidden' });
    await first.send({ type: 'whitelist/add', entry });
    const changed: Settings = { ...first.settings.get(), retentionDays: 90, toast: false };
    await first.ext.storage.local.set({ settings: changed });
    await first.repository.flush();
    await first.clock.advance(1000);
    const second = await boot({ ext: first.ext.restart(), factory: first.factory });
    expect(await second.send({ type: 'status/get' })).toEqual({ historyPersisted: true, counters: { duplicatesHidden: 2, uniqueItems: 1 } });
    expect(second.whitelist.list()).toEqual([entry]);
    expect(second.settings.get()).toEqual(changed);
    const response = (await second.send(lookup(A))) as { matches: unknown[] };
    expect(response.matches[0]).not.toBeNull();
  });

  it('should count 1 unique item per new record and 1 hidden duplicate per stats/hidden (TC-061)', async () => {
    const bg = await boot();
    await bg.send(record(A, 'reddit:t3_1'));
    await bg.send(record(B, 'reddit:t3_2'));
    await bg.send(record(flip(A, 1), 'reddit:t3_3'));
    expect(await bg.send({ type: 'stats/hidden' })).toEqual({ ok: true });
    expect(await bg.send({ type: 'status/get' })).toEqual({ historyPersisted: true, counters: { duplicatesHidden: 1, uniqueItems: 2 } });
  });

  it('should set both counters to 0 if counters/reset arrives (TC-058)', async () => {
    const bg = await boot();
    await bg.send(record(A));
    await bg.send({ type: 'stats/hidden' });
    expect(await bg.send({ type: 'counters/reset' })).toEqual({ ok: true });
    expect(await bg.send({ type: 'status/get' })).toMatchObject({ counters: { duplicatesHidden: 0, uniqueItems: 0 } });
  });

  it('should delete all seen records if history/clear arrives (TC-057)', async () => {
    const bg = await boot();
    await bg.send(record(A));
    await bg.send(record(B, 'reddit:t3_b'));
    expect(await bg.send({ type: 'history/clear' })).toEqual({ ok: true });
    expect(await bg.send(lookup(A, B))).toEqual({ matches: [null, null] });
    const reopened = await boot({ ext: bg.ext.restart(), factory: bg.factory });
    expect(await reopened.send(lookup(A, B))).toEqual({ matches: [null, null] });
  });

  it('should add and remove whitelist entries and save them in storage.local, never storage.sync (TC-084)', async () => {
    const bg = await boot();
    const post: WhitelistEntry = { type: 'post', key: 'x:123' };
    const source: WhitelistEntry = { type: 'source', key: 'x:@someone' };
    expect(await bg.send({ type: 'whitelist/add', entry: post })).toEqual({ ok: true });
    await bg.send({ type: 'whitelist/add', entry: source });
    expect(await bg.send({ type: 'whitelist/remove', entry: post })).toEqual({ ok: true });
    await bg.send({ type: 'stats/hidden' });
    await bg.clock.advance(1000);
    expect(bg.whitelist.list()).toEqual([source]);
    expect(bg.ext.storage.local.dump()).toMatchObject({ whitelist: [source], counters: { duplicatesHidden: 1, uniqueItems: 0 } });
    expect(bg.ext.storage.sync.dump()).toEqual({});
  });

  it('should pass log/warn messages to the log', async () => {
    const bg = await boot();
    expect(await bg.send({ type: 'log/warn', message: 'PureFeed: generic fallback active' })).toEqual({ ok: true });
    expect(bg.logs).toEqual(['PureFeed: generic fallback active']);
  });

  it('should report historyPersisted false and keep matching in memory if IndexedDB fails to open (AC-040)', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('purefeed', 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const bg = await boot({ factory });
    await bg.send(record(C));
    const response = (await bg.send(lookup(flip(C, 1)))) as { matches: unknown[] };
    expect(response.matches[0]).not.toBeNull();
    expect(await bg.send({ type: 'status/get' })).toEqual({ historyPersisted: false, counters: { duplicatesHidden: 0, uniqueItems: 1 } });
  });
});
