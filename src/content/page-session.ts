import type { PostDecision, SessionEvidence } from '../engine/post-decision.ts';
import type { Comparison, DecodeResult, Fingerprint, Platform, PostKey, RecordId, Thresholds } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';

type SessionItem = { postKey: PostKey; platform: Platform; permalink: string; fingerprint: Fingerprint; at: number };

export type PageSession = {
  decisions: Map<PostKey, PostDecision>;
  revealed: Set<PostKey>;
  hiddenCounted: Set<PostKey>;
  ownRecordIds: Map<PostKey, Set<RecordId>>;
  urlResults: Map<string, Promise<DecodeResult>>;
  addItem(item: Omit<SessionItem, 'at'>): void;
  compare(a: Fingerprint, b: Fingerprint, t: Thresholds): Comparison;
  findSessionMatch(fp: Fingerprint, postKey: PostKey, precedes: (other: PostKey) => boolean, t: Thresholds): SessionEvidence | null;
};

export function createPageSession(now: () => number): PageSession {
  const items: SessionItem[] = [];
  const contentIds = new Map<string, number>();
  const idOf = new WeakMap<Fingerprint, number>();
  const comparisons = new Map<string, Comparison>();

  const contentId = (fp: Fingerprint): number => {
    const known = idOf.get(fp);
    if (known !== undefined) {
      return known;
    }
    const words =
      fp.kind === 'sequence' ? [fp.frames, fp.timestamps, [fp.durationS]] : fp.kind === 'image' ? [fp.hash, fp.crops, fp.edges] : [fp.hash];
    const key = `${fp.kind}:${words.map((w) => Array.from(w).join(',')).join('|')}`;
    const id = contentIds.get(key) ?? contentIds.size;
    contentIds.set(key, id);
    idOf.set(fp, id);
    return id;
  };

  const compare = (a: Fingerprint, b: Fingerprint, t: Thresholds): Comparison => {
    const key = `${contentId(a)}:${contentId(b)}:${t.exact}:${t.near}`;
    const cached = comparisons.get(key);
    if (cached) {
      return cached;
    }
    const comparison = compareFingerprints(a, b, t);
    comparisons.set(key, comparison);
    return comparison;
  };

  return {
    decisions: new Map(),
    revealed: new Set(),
    hiddenCounted: new Set(),
    ownRecordIds: new Map(),
    urlResults: new Map(),
    addItem(item) {
      items.push({ ...item, at: now() });
    },
    compare,
    findSessionMatch(fp, postKey, precedes, t) {
      return items
        .filter((item) => item.postKey !== postKey && precedes(item.postKey))
        .reduce<SessionEvidence | null>((best, item) => {
          const { matchClass } = compare(fp, item.fingerprint, t);
          if (matchClass === 'different' || best?.matchClass === 'exact' || (best && matchClass === 'near')) {
            return best;
          }
          return { matchClass, postKey: item.postKey, platform: item.platform, permalink: item.permalink, at: item.at };
        }, null);
    },
  };
}
