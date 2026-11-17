import type { ContentType, Platform, PostKey, SourceKey } from '../shared/types.ts';

export type DetectedMedia = { el: HTMLImageElement | HTMLVideoElement; contentType: ContentType; posterUrl: string | null };

export type DetectedPost = {
  el: Element;
  postKey: PostKey;
  sourceKeys: SourceKey[];
  authorKey: SourceKey | null;
  permalink: string;
  media: DetectedMedia[];
};

export type PlatformAdapter = {
  readonly platform: Platform;
  readonly postSelector: string;
  readonly lateMediaHostSelector?: string;
  readPost(el: Element): DetectedPost | null;
  focalPostKey(url: URL): PostKey | null;
};
