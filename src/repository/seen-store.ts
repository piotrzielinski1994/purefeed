import type { RecordId } from '../shared/types.ts';
import type { SeenRecord } from './seen-record.ts';

export type SeenEntry = [RecordId, SeenRecord];

export type SeenStore = {
  loadAll(): Promise<SeenEntry[]>;
  write(batch: SeenEntry[]): Promise<void>;
  deleteIds(ids: RecordId[]): Promise<void>;
  clear(): Promise<void>;
};

export function createMemorySeenStore(): SeenStore {
  const records = new Map<RecordId, SeenRecord>();
  return {
    loadAll: async () => [...records],
    write: async (batch) =>
      batch.forEach(([id, record]) => {
        records.set(id, record);
      }),
    deleteIds: async (ids) =>
      ids.forEach((id) => {
        records.delete(id);
      }),
    clear: async () => records.clear(),
  };
}
