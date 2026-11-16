import type { ContentType, Fingerprint, Platform, PostKey } from '../shared/types.ts';

export type SeenRecord = {
  fingerprint: Fingerprint;
  contentType: ContentType;
  platform: Platform;
  firstSeenPostKey: PostKey;
  firstSeenPermalink: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
};
