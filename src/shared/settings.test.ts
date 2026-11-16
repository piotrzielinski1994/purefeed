import { describe, expect, it } from 'vitest';
import { createFakeExt, settle } from '../../test/helpers/fake-ext.ts';
import type { Settings } from './types.ts';

const loadSettings = () => import('./settings.ts');

const SPEC_DEFAULTS: Settings = {
  enabled: true,
  mode: 'exact-near',
  exactThreshold: 95,
  nearThreshold: 90,
  retentionDays: 30,
  platforms: { reddit: true, wykop: true, x: true },
  contentTypes: { image: true, gif: true, video: true },
  toast: true,
};

describe('settings defaults and source (AC-036, AC-064)', () => {
  it('should hold the default values of the spec in DEFAULT_SETTINGS', async () => {
    const { DEFAULT_SETTINGS } = await loadSettings();
    expect(DEFAULT_SETTINGS).toEqual(SPEC_DEFAULTS);
  });

  it('should return the defaults if storage.local holds no settings', async () => {
    const { createSettingsSource } = await loadSettings();
    const ext = createFakeExt();
    const source = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
    await source.ready;
    expect(source.get()).toEqual(SPEC_DEFAULTS);
  });

  it('should read settings only from storage.local if storage.sync also holds a settings key (TC-084)', async () => {
    const { createSettingsSource } = await loadSettings();
    const ext = createFakeExt();
    await ext.storage.sync.set({ settings: { ...SPEC_DEFAULTS, retentionDays: 7 } });
    await ext.storage.local.set({ settings: { ...SPEC_DEFAULTS, retentionDays: 90, toast: false } });
    const source = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
    await source.ready;
    expect(source.get()).toEqual({ ...SPEC_DEFAULTS, retentionDays: 90, toast: false });
  });

  it('should keep a changed setting if a new source starts after a browser restart (TC-036)', async () => {
    const { createSettingsSource } = await loadSettings();
    const ext = createFakeExt();
    await ext.storage.local.set({ settings: { ...SPEC_DEFAULTS, mode: 'exact', exactThreshold: 97 } });
    const restarted = ext.restart();
    const source = createSettingsSource({ storage: restarted.storage.local, onChanged: restarted.storage.onChanged });
    await source.ready;
    expect(source.get()).toMatchObject({ mode: 'exact', exactThreshold: 97 });
  });

  it('should call onChange with next and previous settings if storage.local settings change', async () => {
    const { createSettingsSource } = await loadSettings();
    const ext = createFakeExt();
    const source = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
    await source.ready;
    const calls: Array<[Settings, Settings]> = [];
    source.onChange((next, prev) => calls.push([next, prev]));
    const next = { ...SPEC_DEFAULTS, retentionDays: 7 as const };
    await ext.storage.local.set({ settings: next });
    await settle();
    expect(calls).toEqual([[next, SPEC_DEFAULTS]]);
    expect(source.get()).toEqual(next);
  });

  it('should ignore storage.sync changes and stop calling a listener after unsubscribe', async () => {
    const { createSettingsSource } = await loadSettings();
    const ext = createFakeExt();
    const source = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
    await source.ready;
    let calls = 0;
    const unsubscribe = source.onChange(() => calls++);
    await ext.storage.sync.set({ settings: { ...SPEC_DEFAULTS, enabled: false } });
    await settle();
    expect(calls).toBe(0);
    expect(source.get().enabled).toBe(true);
    unsubscribe();
    await ext.storage.local.set({ settings: { ...SPEC_DEFAULTS, enabled: false } });
    await settle();
    expect(calls).toBe(0);
    expect(source.get().enabled).toBe(false);
  });
});
