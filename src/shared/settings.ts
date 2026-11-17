import type { KeyValueStorage, Settings, StorageChangedEvent } from './types.ts';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  mode: 'exact-near',
  exactThreshold: 95,
  nearThreshold: 90,
  retentionDays: 30,
  platforms: { reddit: true, wykop: true, x: true },
  contentTypes: { image: true, gif: true, video: true },
  toast: true,
};

export type SettingsSource = {
  get(): Settings;
  onChange(cb: (next: Settings, prev: Settings) => void): () => void;
};

export const SETTINGS_KEY = 'settings';

const withDefaults = (stored: unknown): Settings =>
  typeof stored === 'object' && stored !== null ? { ...DEFAULT_SETTINGS, ...stored } : DEFAULT_SETTINGS;

export function createSettingsSource(deps: {
  storage: KeyValueStorage;
  onChanged: StorageChangedEvent;
}): SettingsSource & { ready: Promise<void> } {
  const listeners = new Set<(next: Settings, prev: Settings) => void>();
  let current = DEFAULT_SETTINGS;
  let hasChanged = false;

  deps.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.hasOwn(changes, SETTINGS_KEY)) {
      return;
    }
    const prev = current;
    current = withDefaults(changes[SETTINGS_KEY].newValue);
    hasChanged = true;
    listeners.forEach((cb) => {
      cb(current, prev);
    });
  });

  const ready = deps.storage.get(SETTINGS_KEY).then((items) => {
    if (!hasChanged) {
      current = withDefaults(items[SETTINGS_KEY]);
    }
  });

  return {
    ready,
    get: () => current,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

type Range = { field: 'exactThreshold' | 'nearThreshold'; min: number; max: number; message: string };

const THRESHOLD_RANGES: readonly Range[] = [
  { field: 'exactThreshold', min: 90, max: 100, message: 'Exact threshold must be between 90% and 100%.' },
  { field: 'nearThreshold', min: 75, max: 99, message: 'Similar threshold must be between 75% and 99%.' },
];
const RETENTION_DAYS: readonly unknown[] = [7, 30, 90, null];

export type SettingsPatchResult = { ok: true; value: Settings } | { ok: false; field: keyof Settings; message: string };

export function validateSettingsPatch(current: Settings, patch: Partial<Settings>): SettingsPatchResult {
  const value = { ...current, ...patch };
  const outOfRange = THRESHOLD_RANGES.find((r) => !Number.isInteger(value[r.field]) || value[r.field] < r.min || value[r.field] > r.max);
  if (outOfRange) {
    return { ok: false, field: outOfRange.field, message: outOfRange.message };
  }
  if (value.nearThreshold >= value.exactThreshold) {
    const field = 'nearThreshold' in patch ? 'nearThreshold' : 'exactThreshold';
    return { ok: false, field, message: 'Similar threshold must be lower than exact threshold.' };
  }
  if (!RETENTION_DAYS.includes(value.retentionDays)) {
    return { ok: false, field: 'retentionDays', message: 'Retention must be 7, 30 or 90 days or forever.' };
  }
  return { ok: true, value };
}
