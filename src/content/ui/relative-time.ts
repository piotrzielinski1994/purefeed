const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNITS = [
  { ms: DAY_MS, label: 'd' },
  { ms: HOUR_MS, label: 'h' },
  { ms: MINUTE_MS, label: 'min' },
] as const;

export function formatRelative(fromMs: number, nowMs: number): string {
  const elapsed = nowMs - fromMs;
  const unit = UNITS.find(({ ms }) => elapsed >= ms);
  return unit ? `${Math.floor(elapsed / unit.ms)} ${unit.label} ago` : 'just now';
}
