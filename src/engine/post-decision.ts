import type { ContentType, Platform, PostKey, RecordId, SeenMatch, Settings, SourceKey } from '../shared/types.ts';

type HideClass = 'exact' | 'near';

export type SessionEvidence = { matchClass: HideClass; postKey: PostKey; platform: Platform; permalink: string; at: number };
export type ItemEvidence = { contentType: ContentType; seen: SeenMatch | null; session: SessionEvidence | null };
export type PostDecision =
  | { hide: false; reason: 'disabled' | 'no-media' | 'unique' | 'whitelisted' | 'focal' | 'revealed' }
  | { hide: true; matchClass: HideClass; platform: Platform; firstSeenAt: number; permalink: string };

type HideDecision = Extract<PostDecision, { hide: true }>;

export type PostDecisionInput = {
  postKey: PostKey;
  platform: Platform;
  sourceKeys: SourceKey[];
  isFocal: boolean;
  revealed: boolean;
  items: ItemEvidence[];
  settings: Settings;
  isWhitelisted: (key: string) => boolean;
  ownRecordIds: ReadonlySet<RecordId>;
};

const ALLOWED_CLASSES: Record<Settings['mode'], readonly HideClass[]> = { exact: ['exact'], 'exact-near': ['exact', 'near'] };

const isStronger = (a: HideDecision, b: HideDecision): boolean =>
  a.matchClass === b.matchClass ? a.firstSeenAt < b.firstSeenAt : a.matchClass === 'exact';

const strongest = (candidates: HideDecision[]): HideDecision | null =>
  candidates.reduce<HideDecision | null>((best, c) => (best && !isStronger(c, best) ? best : c), null);

function itemEvidence(item: ItemEvidence, input: PostDecisionInput): HideDecision | null {
  const { seen, session } = item;
  const fromSeen: HideDecision | null =
    seen && !input.ownRecordIds.has(seen.recordId)
      ? { hide: true, matchClass: seen.matchClass, platform: seen.platform, firstSeenAt: seen.firstSeenAt, permalink: seen.firstSeenPermalink }
      : null;
  const fromSession: HideDecision | null = session
    ? { hide: true, matchClass: session.matchClass, platform: session.platform, firstSeenAt: session.at, permalink: session.permalink }
    : null;
  const allowed = ALLOWED_CLASSES[input.settings.mode];
  return strongest([fromSeen, fromSession].filter((c): c is HideDecision => c !== null && allowed.includes(c.matchClass)));
}

export function decidePost(input: PostDecisionInput): PostDecision {
  const { settings } = input;
  if (!settings.enabled || !settings.platforms[input.platform]) {
    return { hide: false, reason: 'disabled' };
  }
  const items = input.items.filter((item) => settings.contentTypes[item.contentType]);
  if (items.length === 0) {
    return { hide: false, reason: 'no-media' };
  }
  if ([input.postKey, ...input.sourceKeys].some(input.isWhitelisted)) {
    return { hide: false, reason: 'whitelisted' };
  }
  if (input.isFocal) {
    return { hide: false, reason: 'focal' };
  }
  if (input.revealed) {
    return { hide: false, reason: 'revealed' };
  }
  const evidence = items.map((item) => itemEvidence(item, input));
  if (evidence.some((e) => e === null)) {
    return { hide: false, reason: 'unique' };
  }
  return strongest(evidence.filter((e): e is HideDecision => e !== null)) ?? { hide: false, reason: 'unique' };
}
