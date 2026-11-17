import type { DetectedMedia, DetectedPost, PlatformAdapter } from '../../src/adapters/adapter.ts';
import type { ContentType, Platform, PostKey } from '../../src/shared/types.ts';
import { setLayout } from './fake-observers.ts';

export const POST_SELECTOR = 'article[data-post]';

const PERMALINK_PATH = /\/comments\/([a-z0-9]+)\//;

export const postKeyOf = (platform: Platform, id: string): PostKey => `${platform}:t3_${id}`;
export const authorKeyOf = (platform: Platform, author: string): string => `${platform}:u/${author}`;
export const permalinkOf = (id: string): string => `https://www.reddit.com/r/test/comments/${id}/post/`;

export function createTestAdapter(platform: Platform = 'reddit'): PlatformAdapter {
  return {
    platform,
    postSelector: POST_SELECTOR,
    readPost(el: Element): DetectedPost | null {
      const id = el.getAttribute('data-post');
      if (!id) return null;
      const author = el.getAttribute('data-author');
      const authorKey = author ? authorKeyOf(platform, author) : null;
      const media: DetectedMedia[] = [...el.querySelectorAll('img, video')].map((m) => ({
        el: m as HTMLImageElement | HTMLVideoElement,
        contentType: (m.getAttribute('data-type') as ContentType | null) ?? (m.tagName === 'IMG' ? 'image' : 'video'),
        posterUrl: m.tagName === 'VIDEO' ? m.getAttribute('poster') : null,
      }));
      return {
        el,
        postKey: postKeyOf(platform, id),
        sourceKeys: authorKey ? [authorKey] : [],
        authorKey,
        permalink: permalinkOf(id),
        media,
      };
    },
    focalPostKey(url: URL): PostKey | null {
      const match = PERMALINK_PATH.exec(url.pathname);
      return match ? postKeyOf(platform, match[1]) : null;
    },
  };
}

export type MediaSpec =
  | { kind: 'img'; src?: string; width?: number; height?: number }
  | { kind: 'video'; src: string; poster?: string; type?: 'gif' | 'video'; width?: number; height?: number };

export type PostSpec = { id: string; author?: string; top?: number; media?: MediaSpec[]; text?: string };

export function makePost(doc: Document, spec: PostSpec): HTMLElement {
  const post = doc.createElement('article');
  post.setAttribute('data-post', spec.id);
  if (spec.author) post.setAttribute('data-author', spec.author);
  const top = spec.top ?? 0;
  const p = doc.createElement('p');
  p.textContent = spec.text ?? `Post ${spec.id}`;
  post.append(p);
  for (const m of spec.media ?? []) {
    const el = doc.createElement(m.kind);
    if (m.kind === 'video') {
      if (m.type) el.setAttribute('data-type', m.type);
      if (m.poster) el.setAttribute('poster', m.poster);
    }
    if (m.src) el.setAttribute('src', m.src);
    setLayout(el, { top: top + 40, width: m.width ?? 600, height: m.height ?? 400 });
    post.append(el);
  }
  setLayout(post, { top, width: 640, height: 500 });
  return post;
}

export function makeFeed(doc: Document, posts: PostSpec[]): { feed: HTMLElement; posts: HTMLElement[] } {
  const feed = doc.createElement('main');
  const els = posts.map((spec) => makePost(doc, spec));
  feed.append(...els);
  doc.body.append(feed);
  return { feed, posts: els };
}

export const mediaOf = (post: Element): HTMLImageElement | HTMLVideoElement =>
  post.querySelector('img, video') as HTMLImageElement | HTMLVideoElement;
