import { describe, expect, it } from 'vitest';
import { createFakeExt, settle } from '../../test/helpers/fake-ext.ts';
import type { RetentionDays, Settings } from './types.ts';

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

  it('should keep a changed setting if a new source starts after a browser restart (TC-050)', async () => {
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

const THRESHOLD_ORDER = 'Similar threshold must be lower than exact threshold.';

describe('settings patch validation (AC-068)', () => {
  it('should merge a valid patch into the current settings', async () => {
    const { validateSettingsPatch } = await loadSettings();
    const current: Settings = { ...SPEC_DEFAULTS, mode: 'exact', toast: false };
    expect(validateSettingsPatch(current, { nearThreshold: 85, retentionDays: 90 })).toEqual({
      ok: true,
      value: { ...current, nearThreshold: 85, retentionDays: 90 },
    });
  });

  it('should reject a near threshold at or above the exact threshold with the spec message (TC-088)', async () => {
    const { validateSettingsPatch } = await loadSettings();
    const current: Settings = { ...SPEC_DEFAULTS, exactThreshold: 90, nearThreshold: 85 };
    expect(validateSettingsPatch(current, { nearThreshold: 92 })).toEqual({ ok: false, field: 'nearThreshold', message: THRESHOLD_ORDER });
    expect(validateSettingsPatch(current, { nearThreshold: 90 })).toEqual({ ok: false, field: 'nearThreshold', message: THRESHOLD_ORDER });
  });

  it('should reject an exact threshold lowered to the near threshold with the spec message', async () => {
    const { validateSettingsPatch } = await loadSettings();
    const result = validateSettingsPatch(SPEC_DEFAULTS, { exactThreshold: 90 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toBe(THRESHOLD_ORDER);
  });

  it('should reject a near threshold outside 75-99 with a range message (TC-088)', async () => {
    const { validateSettingsPatch } = await loadSettings();
    for (const nearThreshold of [74, Number.NaN]) {
      const result = validateSettingsPatch(SPEC_DEFAULTS, { nearThreshold });
      expect(result, String(nearThreshold)).toMatchObject({ ok: false, field: 'nearThreshold' });
      expect(result.ok ? '' : result.message, String(nearThreshold)).toMatch(/75\D.*99/);
    }
    const atMax = validateSettingsPatch({ ...SPEC_DEFAULTS, exactThreshold: 100 }, { nearThreshold: 100 });
    expect(atMax).toMatchObject({ ok: false, field: 'nearThreshold' });
  });

  it('should reject an exact threshold outside 90-100 with a range message', async () => {
    const { validateSettingsPatch } = await loadSettings();
    const current: Settings = { ...SPEC_DEFAULTS, nearThreshold: 80 };
    for (const exactThreshold of [89, 101]) {
      const result = validateSettingsPatch(current, { exactThreshold });
      expect(result, String(exactThreshold)).toMatchObject({ ok: false, field: 'exactThreshold' });
      expect(result.ok ? '' : result.message, String(exactThreshold)).toMatch(/90\D.*100/);
    }
  });

  it('should accept the range boundaries exact 90 with near 75 and exact 100 with near 99', async () => {
    const { validateSettingsPatch } = await loadSettings();
    expect(validateSettingsPatch(SPEC_DEFAULTS, { exactThreshold: 90, nearThreshold: 75 })).toMatchObject({ ok: true });
    expect(validateSettingsPatch(SPEC_DEFAULTS, { exactThreshold: 100, nearThreshold: 99 })).toMatchObject({ ok: true });
  });

  it('should accept retention 7, 30, 90 days and forever and reject any other period', async () => {
    const { validateSettingsPatch } = await loadSettings();
    for (const retentionDays of [7, 30, 90, null] satisfies RetentionDays[]) {
      expect(validateSettingsPatch(SPEC_DEFAULTS, { retentionDays }), String(retentionDays)).toEqual({
        ok: true,
        value: { ...SPEC_DEFAULTS, retentionDays },
      });
    }
    expect(validateSettingsPatch(SPEC_DEFAULTS, { retentionDays: 14 as unknown as RetentionDays })).toMatchObject({
      ok: false,
      field: 'retentionDays',
    });
  });
});
