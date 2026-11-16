import type { SeenRepository } from '../repository/seen-repository.ts';
import type { SettingsSource } from '../shared/settings.ts';
import type { AlarmScheduler, RetentionDays, SetTimer } from '../shared/types.ts';

export const PURGE_ALARM = 'purefeed-purge';
const PURGE_PERIOD_MINUTES = 24 * 60;
const SHORTENED_PURGE_DELAY_MS = 1000;

const retentionLength = (days: RetentionDays): number => days ?? Number.POSITIVE_INFINITY;

export function startRetention(deps: {
  repository: Pick<SeenRepository, 'purge'>;
  settings: SettingsSource & { ready?: Promise<void> };
  alarms: AlarmScheduler;
  setTimer: SetTimer;
}): void {
  const purge = (): void => {
    void Promise.resolve(deps.settings.ready).then(() => deps.repository.purge(deps.settings.get().retentionDays));
  };
  purge();
  void deps.alarms.create(PURGE_ALARM, { periodInMinutes: PURGE_PERIOD_MINUTES });
  deps.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PURGE_ALARM) {
      purge();
    }
  });
  deps.settings.onChange((next, prev) => {
    if (retentionLength(next.retentionDays) < retentionLength(prev.retentionDays)) {
      deps.setTimer(purge, SHORTENED_PURGE_DELAY_MS);
    }
  });
}
