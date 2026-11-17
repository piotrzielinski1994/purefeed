import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings.ts';

const loadFormat = () => import('./format.ts');

describe('popup threshold and retention labels (AC-062)', () => {
  it('should label the default settings Similar >= 90% (TC-082)', async () => {
    const { thresholdLabel } = await loadFormat();
    expect(thresholdLabel(DEFAULT_SETTINGS)).toBe('Similar >= 90%');
  });

  it('should label mode exact only with the current exact threshold (TC-082)', async () => {
    const { thresholdLabel } = await loadFormat();
    expect(thresholdLabel({ ...DEFAULT_SETTINGS, mode: 'exact' })).toBe('Exact >= 95%');
    expect(thresholdLabel({ ...DEFAULT_SETTINGS, mode: 'exact', exactThreshold: 97 })).toBe('Exact >= 97%');
  });

  it('should label mode exact and near with the current near threshold', async () => {
    const { thresholdLabel } = await loadFormat();
    expect(thresholdLabel({ ...DEFAULT_SETTINGS, nearThreshold: 85 })).toBe('Similar >= 85%');
  });

  it('should label the retention periods 7, 30 and 90 days and forever', async () => {
    const { retentionLabel } = await loadFormat();
    expect([retentionLabel(7), retentionLabel(30), retentionLabel(90)]).toEqual(['7 days', '30 days', '90 days']);
    expect(retentionLabel(null)).toMatch(/^forever$/i);
  });
});
