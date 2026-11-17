import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../../../test/helpers/fingerprints.ts';

const loadRelative = () => import('./relative-time.ts');

const NOW = Date.UTC(2026, 10, 17, 12);
const MINUTE_MS = 60_000;

describe('formatRelative (AC-051)', () => {
  it('should say just now under 1 minute', async () => {
    const { formatRelative } = await loadRelative();
    expect(formatRelative(NOW, NOW)).toBe('just now');
    expect(formatRelative(NOW - 59_000, NOW)).toBe('just now');
  });

  it('should count whole minutes under 1 hour', async () => {
    const { formatRelative } = await loadRelative();
    expect(formatRelative(NOW - MINUTE_MS, NOW)).toBe('1 min ago');
    expect(formatRelative(NOW - 5 * MINUTE_MS - 30_000, NOW)).toBe('5 min ago');
    expect(formatRelative(NOW - 59 * MINUTE_MS, NOW)).toBe('59 min ago');
  });

  it('should count whole hours under 1 day', async () => {
    const { formatRelative } = await loadRelative();
    expect(formatRelative(NOW - HOUR_MS, NOW)).toBe('1 h ago');
    expect(formatRelative(NOW - 3 * HOUR_MS - 20 * MINUTE_MS, NOW)).toBe('3 h ago');
    expect(formatRelative(NOW - 23 * HOUR_MS, NOW)).toBe('23 h ago');
  });

  it('should count whole days from 1 day (TC-070)', async () => {
    const { formatRelative } = await loadRelative();
    expect(formatRelative(NOW - DAY_MS, NOW)).toBe('1 d ago');
    expect(formatRelative(NOW - 2 * DAY_MS, NOW)).toBe('2 d ago');
    expect(formatRelative(NOW - 400 * DAY_MS, NOW)).toBe('400 d ago');
  });

  it('should say just now for a timestamp in the future', async () => {
    const { formatRelative } = await loadRelative();
    expect(formatRelative(NOW + 5 * MINUTE_MS, NOW)).toBe('just now');
  });
});
