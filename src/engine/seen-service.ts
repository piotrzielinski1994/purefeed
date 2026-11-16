import type { SeenRepository } from '../repository/seen-repository.ts';
import type { SettingsSource } from '../shared/settings.ts';
import type { Fingerprint, RecordId, SeenMatch, Sighting, Thresholds } from '../shared/types.ts';
import type { Counters } from './counters.ts';

export type SeenService = {
  lookup(fps: Fingerprint[]): Promise<Array<SeenMatch | null>>;
  record(s: Sighting): Promise<{ recordId: RecordId; isNew: boolean }>;
};

export function createSeenService(deps: {
  repository: SeenRepository;
  settings: Pick<SettingsSource, 'get'>;
  counters: Pick<Counters, 'addUnique'>;
}): SeenService {
  const thresholds = (): Thresholds => {
    const { exactThreshold, nearThreshold } = deps.settings.get();
    return { exact: exactThreshold, near: nearThreshold };
  };

  return {
    async lookup(fps) {
      await deps.repository.ready;
      const t = thresholds();
      return fps.map((fp) => {
        const match = deps.repository.lookup(fp, t);
        if (!match || match.comparison.matchClass === 'different') {
          return null;
        }
        const { record } = match;
        return {
          recordId: match.id,
          matchClass: match.comparison.matchClass,
          platform: record.platform,
          firstSeenPostKey: record.firstSeenPostKey,
          firstSeenPermalink: record.firstSeenPermalink,
          firstSeenAt: record.firstSeenAt,
        };
      });
    },
    async record(s) {
      await deps.repository.ready;
      const { id, isNew } = deps.repository.recordSighting(s, thresholds());
      if (isNew) {
        deps.counters.addUnique();
      }
      return { recordId: id, isNew };
    },
  };
}
