import { ext } from '../../compat/browser.ts';
import { createSettingsSource, SETTINGS_KEY } from '../../shared/settings.ts';
import type { Settings } from '../../shared/types.ts';

export function connectSettings() {
  const source = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
  let latest: Settings | null = null;
  source.onChange((next) => {
    latest = next;
  });
  const current = (): Settings => latest ?? source.get();
  return {
    ready: source.ready,
    current,
    onChange: source.onChange,
    save(patch: Partial<Settings>): void {
      latest = { ...current(), ...patch };
      void ext.storage.local.set({ [SETTINGS_KEY]: latest });
    },
  };
}
