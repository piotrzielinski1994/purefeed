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
