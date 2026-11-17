import type { PostDecision, SessionEvidence } from '../engine/post-decision.ts';
import type { DecodeResult, Fingerprint, Platform, PostKey, RecordId, Thresholds } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';

type SessionItem = { postKey: PostKey; platform: Platform; permalink: string; fingerprint: Fingerprint; at: number };

export type PageSession = {
  decisions: Map<PostKey, PostDecision>;
  revealed: Set<PostKey>;
  hiddenCounted: Set<PostKey>;
  ownRecordIds: Map<PostKey, Set<RecordId>>;
  urlResults: Map<string, Promise<DecodeResult>>;
  addItem(item: Omit<SessionItem, 'at'>): void;
  findSessionMatch(fp: Fingerprint, postKey: PostKey, precedes: (other: PostKey) => boolean, t: Thresholds): SessionEvidence | null;
};

export function createPageSession(now: () => number): PageSession {
  const items: SessionItem[] = [];

  return {
    decisions: new Map(),
    revealed: new Set(),
    hiddenCounted: new Set(),
    ownRecordIds: new Map(),
    urlResults: new Map(),
    addItem(item) {
      items.push({ ...item, at: now() });
    },
    findSessionMatch(fp, postKey, precedes, t) {
      return items
        .filter((item) => item.postKey !== postKey && precedes(item.postKey))
        .reduce<SessionEvidence | null>((best, item) => {
          const { matchClass } = compareFingerprints(fp, item.fingerprint, t);
          if (matchClass === 'different' || best?.matchClass === 'exact' || (best && matchClass === 'near')) {
            return best;
          }
          return { matchClass, postKey: item.postKey, platform: item.platform, permalink: item.permalink, at: item.at };
        }, null);
    },
  };
}
