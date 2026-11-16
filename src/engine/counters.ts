import { throttle } from '../shared/throttle.ts';
import type { CounterValues, KeyValueStorage, SetTimer } from '../shared/types.ts';

export type Counters = {
  ready: Promise<void>;
  get(): CounterValues;
  addHidden(): void;
  addUnique(): void;
  reset(): Promise<void>;
};

const COUNTERS_KEY = 'counters';
const WRITE_INTERVAL_MS = 1000;
const ZERO: CounterValues = { duplicatesHidden: 0, uniqueItems: 0 };

const isCounterValues = (value: unknown): value is CounterValues =>
  typeof value === 'object' &&
  value !== null &&
  'duplicatesHidden' in value &&
  'uniqueItems' in value &&
  typeof value.duplicatesHidden === 'number' &&
  typeof value.uniqueItems === 'number';

export function createCounters({ storage, now, setTimer }: { storage: KeyValueStorage; now: () => number; setTimer: SetTimer }): Counters {
  let values = ZERO;
  const write = (): Promise<void> => storage.set({ [COUNTERS_KEY]: values });
  const scheduleWrite = throttle(() => void write(), { now, setTimer, intervalMs: WRITE_INTERVAL_MS });
  const add = (patch: Partial<CounterValues>): void => {
    values = { ...values, ...patch };
    scheduleWrite();
  };

  const ready = storage.get(COUNTERS_KEY).then((items) => {
    const stored = items[COUNTERS_KEY];
    values = isCounterValues(stored) ? stored : ZERO;
  });

  return {
    ready,
    get: () => values,
    addHidden: () => add({ duplicatesHidden: values.duplicatesHidden + 1 }),
    addUnique: () => add({ uniqueItems: values.uniqueItems + 1 }),
    reset() {
      values = ZERO;
      return write();
    },
  };
}
