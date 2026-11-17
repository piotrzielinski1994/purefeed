import { throttle } from '../shared/throttle.ts';
import type { Fingerprint, RecordId, RetentionDays, Sighting, Thresholds } from '../shared/types.ts';
import { type IndexMatch, SeenIndex } from './seen-index.ts';
import type { SeenEntry, SeenStore } from './seen-store.ts';

export type SeenRepository = {
  ready: Promise<void>;
  persisted(): boolean;
  lookup(fp: Fingerprint, t: Thresholds): IndexMatch | null;
  recordSighting(s: Sighting, t: Thresholds): { id: RecordId; isNew: boolean };
  purge(days: RetentionDays): Promise<number>;
  clear(): Promise<void>;
  flush(): Promise<void>;
};

export type SeenRepositoryDeps = {
  openStore: () => Promise<SeenStore>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  newId: () => RecordId;
};

const WRITE_INTERVAL_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createSeenRepository({ openStore, now, setTimer, newId }: SeenRepositoryDeps): SeenRepository {
  const index = new SeenIndex();
  const dirty = new Set<RecordId>();
  let store: SeenStore | null = null;

  const persist = (op: (s: SeenStore) => Promise<void>): Promise<void> => {
    if (!store) {
      return Promise.resolve();
    }
    return Promise.resolve(store)
      .then(op)
      .catch(() => {
        store = null;
      });
  };

  const writeDirty = (): Promise<void> => {
    const batch = [...dirty].flatMap((id): SeenEntry[] => {
      const record = index.get(id);
      return record ? [[id, record]] : [];
    });
    dirty.clear();
    return batch.length === 0 ? Promise.resolve() : persist((s) => s.write(batch));
  };

  const scheduleWrite = throttle(() => void ready.then(writeDirty), { now, setTimer, intervalMs: WRITE_INTERVAL_MS });
  const markDirty = (id: RecordId): void => {
    dirty.add(id);
    scheduleWrite();
  };

  const ready = openStore()
    .then(async (opened) => {
      const entries = await opened.loadAll();
      entries.forEach(([id, record]) => {
        index.upsert(id, record);
      });
      store = opened;
    })
    .catch(() => {
      store = null;
    });

  return {
    ready,
    persisted: () => store !== null,
    lookup: (fp, t) => index.findBest(fp, t),
    recordSighting(s, t) {
      const at = now();
      const match = index.findBest(s.fingerprint, t);
      if (match) {
        index.upsert(match.id, { ...match.record, lastSeenAt: at, seenCount: match.record.seenCount + 1 });
        markDirty(match.id);
        return { id: match.id, isNew: false };
      }
      const id = newId();
      index.upsert(id, {
        fingerprint: s.fingerprint,
        contentType: s.contentType,
        platform: s.platform,
        firstSeenPostKey: s.postKey,
        firstSeenPermalink: s.permalink,
        firstSeenAt: at,
        lastSeenAt: at,
        seenCount: 1,
      });
      markDirty(id);
      return { id, isNew: true };
    },
    async purge(days) {
      await ready;
      if (days === null) {
        return 0;
      }
      const ids = index.idsLastSeenBefore(now() - days * DAY_MS);
      index.remove(ids);
      ids.forEach((id) => {
        dirty.delete(id);
      });
      if (ids.length > 0) {
        await persist((s) => s.deleteIds(ids));
      }
      return ids.length;
    },
    async clear() {
      await ready;
      index.clear();
      dirty.clear();
      await persist((s) => s.clear());
    },
    async flush() {
      await ready;
      await writeDirty();
    },
  };
}
