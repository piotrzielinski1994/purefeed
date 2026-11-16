import { describe, expect, it } from 'vitest';
import { createFakeExt, type FakeExt } from '../../test/helpers/fake-ext.ts';

const loadWhitelist = () => import('./whitelist-store.ts');

async function setup(ext: FakeExt = createFakeExt()) {
  const { createWhitelistStore } = await loadWhitelist();
  const whitelist = createWhitelistStore({ storage: ext.storage.local });
  await whitelist.ready;
  return { whitelist, ext };
}

const POST = { type: 'post', key: 'reddit:t3_abc' } as const;
const SOURCE = { type: 'source', key: 'x:@someone' } as const;

describe('whitelist store (AC-036, AC-064)', () => {
  it('should list and report added entries and save them in storage.local only', async () => {
    const { whitelist, ext } = await setup();
    expect(whitelist.list()).toEqual([]);
    await whitelist.add(POST);
    await whitelist.add(SOURCE);
    expect(whitelist.list()).toEqual([POST, SOURCE]);
    expect(whitelist.has('reddit:t3_abc')).toBe(true);
    expect(whitelist.has('x:@someone')).toBe(true);
    expect(whitelist.has('x:@other')).toBe(false);
    expect(ext.storage.local.dump().whitelist).toEqual([POST, SOURCE]);
    expect(ext.storage.sync.dump()).toEqual({});
  });

  it('should keep 1 entry if the same entry is added twice', async () => {
    const { whitelist } = await setup();
    await whitelist.add(POST);
    await whitelist.add({ ...POST });
    expect(whitelist.list()).toEqual([POST]);
  });

  it('should remove only the given entry', async () => {
    const { whitelist, ext } = await setup();
    await whitelist.add(POST);
    await whitelist.add(SOURCE);
    await whitelist.remove(POST);
    expect(whitelist.list()).toEqual([SOURCE]);
    expect(whitelist.has('reddit:t3_abc')).toBe(false);
    expect(ext.storage.local.dump().whitelist).toEqual([SOURCE]);
  });

  it('should keep the entries if a new store starts after a browser restart (TC-036)', async () => {
    const first = await setup();
    await first.whitelist.add(POST);
    await first.whitelist.add(SOURCE);
    const second = await setup(first.ext.restart());
    expect(second.whitelist.list()).toEqual([POST, SOURCE]);
    expect(second.whitelist.has('x:@someone')).toBe(true);
  });
});
