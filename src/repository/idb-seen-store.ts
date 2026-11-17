import type { RecordId } from '../shared/types.ts';
import type { SeenRecord } from './seen-record.ts';
import type { SeenEntry, SeenStore } from './seen-store.ts';

const DB_NAME = 'purefeed';
const DB_VERSION = 3;
const FIRST_VERSION = 1;
const STORE = 'seen';
const LAST_SEEN_INDEX = 'lastSeenAt';

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const completion = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

function deleteImageRecords(store: IDBObjectStore): void {
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) {
      return;
    }
    if ((cursor.value as SeenRecord).fingerprint.kind === 'image') {
      cursor.delete();
    }
    cursor.continue();
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const upgrade = request.transaction;
    if (event.oldVersion >= FIRST_VERSION && upgrade) {
      deleteImageRecords(upgrade.objectStore(STORE));
      return;
    }
    request.result.createObjectStore(STORE).createIndex(LAST_SEEN_INDEX, LAST_SEEN_INDEX);
  };
  return requestResult(request);
}

export async function openIdbSeenStore(factory: IDBFactory): Promise<SeenStore> {
  const db = await openDatabase(factory);
  const update = async (change: (store: IDBObjectStore) => void): Promise<void> => {
    const tx = db.transaction(STORE, 'readwrite');
    change(tx.objectStore(STORE));
    return completion(tx);
  };
  return {
    async loadAll() {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
      return values.map((record: SeenRecord, i): SeenEntry => [String(keys[i]), record]);
    },
    write: (batch) =>
      update((store) =>
        batch.forEach(([id, record]) => {
          store.put(record, id);
        }),
      ),
    deleteIds: (ids: RecordId[]) =>
      update((store) =>
        ids.forEach((id) => {
          store.delete(id);
        }),
      ),
    clear: () => update((store) => store.clear()),
  };
}
