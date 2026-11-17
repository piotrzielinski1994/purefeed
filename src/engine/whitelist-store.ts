import type { KeyValueStorage, WhitelistEntry } from '../shared/types.ts';

export type WhitelistStore = {
  list(): WhitelistEntry[];
  has(key: string): boolean;
  add(e: WhitelistEntry): Promise<void>;
  remove(e: WhitelistEntry): Promise<void>;
};

export const WHITELIST_KEY = 'whitelist';

const isSameEntry = (a: WhitelistEntry, b: WhitelistEntry): boolean => a.type === b.type && a.key === b.key;

export function createWhitelistStore({ storage }: { storage: KeyValueStorage }): WhitelistStore & { ready: Promise<void> } {
  let entries: WhitelistEntry[] = [];

  const save = (next: WhitelistEntry[]): Promise<void> => {
    entries = next;
    return storage.set({ [WHITELIST_KEY]: next });
  };

  const ready = storage.get(WHITELIST_KEY).then((items) => {
    const stored = items[WHITELIST_KEY];
    entries = Array.isArray(stored) ? stored : [];
  });

  return {
    ready,
    list: () => entries,
    has: (key) => entries.some((e) => e.key === key),
    add: (e) => (entries.some((x) => isSameEntry(x, e)) ? Promise.resolve() : save([...entries, { type: e.type, key: e.key }])),
    remove: (e) => save(entries.filter((x) => !isSameEntry(x, e))),
  };
}
