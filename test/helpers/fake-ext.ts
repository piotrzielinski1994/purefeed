type Items = Record<string, unknown>;
type Keys = string | string[] | Items | null | undefined;
export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: StorageChanges, areaName: string) => void;
export type FakeAlarm = { name: string; scheduledTime: number; periodInMinutes?: number };
type AlarmListener = (alarm: FakeAlarm) => void;

export type FakeEvent<L> = {
  addListener(listener: L): void;
  removeListener(listener: L): void;
  hasListener(listener: L): boolean;
};

export type FakeStorageArea = {
  get(keys?: Keys): Promise<Items>;
  set(items: Items): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setCalls: number;
  dump(): Items;
};

export type FakeExt = {
  storage: { local: FakeStorageArea; sync: FakeStorageArea; onChanged: FakeEvent<ChangeListener> };
  alarms: {
    create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }): Promise<void>;
    onAlarm: FakeEvent<AlarmListener>;
    created: Map<string, { periodInMinutes?: number; delayInMinutes?: number; when?: number }>;
    fire(name: string): void;
  };
  restart(): FakeExt;
};

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function createEvent<L extends (...args: never[]) => void>(): FakeEvent<L> & { emit(...args: Parameters<L>): void } {
  const listeners = new Set<L>();
  return {
    addListener: (l) => void listeners.add(l),
    removeListener: (l) => void listeners.delete(l),
    hasListener: (l) => listeners.has(l),
    emit: (...args) => {
      for (const l of [...listeners]) l(...args);
    },
  };
}

function createArea(data: Map<string, unknown>, areaName: string, emit: (changes: StorageChanges, areaName: string) => void): FakeStorageArea {
  const area: FakeStorageArea = {
    setCalls: 0,
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
      }
      const defaults: Items =
        typeof keys === 'string' ? { [keys]: undefined } : Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, undefined])) : keys;
      const out: Items = {};
      for (const [k, fallback] of Object.entries(defaults)) {
        if (data.has(k)) out[k] = clone(data.get(k));
        else if (fallback !== undefined) out[k] = clone(fallback);
      }
      return out;
    },
    async set(items) {
      area.setCalls++;
      const changes: StorageChanges = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) };
        data.set(k, clone(v));
      }
      queueMicrotask(() => emit(changes, areaName));
    },
    async remove(keys) {
      const changes: StorageChanges = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (data.has(k)) changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      queueMicrotask(() => emit(changes, areaName));
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, clone(v)])),
  };
  return area;
}

export function createFakeExt(
  shared: { local: Map<string, unknown>; sync: Map<string, unknown> } = { local: new Map(), sync: new Map() },
): FakeExt {
  const onChanged = createEvent<ChangeListener>();
  const onAlarm = createEvent<AlarmListener>();
  const created: FakeExt['alarms']['created'] = new Map();
  return {
    storage: {
      local: createArea(shared.local, 'local', onChanged.emit),
      sync: createArea(shared.sync, 'sync', onChanged.emit),
      onChanged,
    },
    alarms: {
      async create(name, info) {
        created.set(name, { ...info });
      },
      onAlarm,
      created,
      fire(name) {
        onAlarm.emit({ name, scheduledTime: Date.now(), periodInMinutes: created.get(name)?.periodInMinutes });
      },
    },
    restart: () => createFakeExt(shared),
  };
}

export const settle = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

export type FakeClock = {
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: unknown): void;
  advance(ms: number): Promise<void>;
  set(ms: number): void;
};

export function createFakeClock(start = Date.UTC(2026, 10, 17, 12)): FakeClock {
  let t = start;
  let seq = 0;
  const timers: Array<{ at: number; seq: number; fn: () => void }> = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      seq++;
      timers.push({ at: t + Math.max(0, ms), seq, fn });
      return seq;
    },
    clearTimer(id) {
      const index = timers.findIndex((timer) => timer.seq === id);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms) {
      const target = t + ms;
      await settle();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        t = next.at;
        next.fn();
        await settle();
      }
      t = target;
    },
    set(ms) {
      t = ms;
    },
  };
}
