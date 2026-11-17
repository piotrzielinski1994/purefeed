import type { RetentionDays, Settings } from '../../shared/types.ts';

export const RETENTION_PERIODS: readonly RetentionDays[] = [7, 30, 90, null];

const countFormat = new Intl.NumberFormat('en-US');

export function thresholdLabel(s: Settings): string {
  return s.mode === 'exact' ? `Exact >= ${s.exactThreshold}%` : `Similar >= ${s.nearThreshold}%`;
}

export const retentionLabel = (days: RetentionDays): string => (days === null ? 'Forever' : `${days} days`);

export const retentionValue = (days: RetentionDays): string => String(days ?? 'forever');

export const parseRetention = (value: string): RetentionDays | undefined => RETENTION_PERIODS.find((days) => retentionValue(days) === value);

export const formatCount = (n: number): string => countFormat.format(n);
