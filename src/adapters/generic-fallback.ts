import type { Platform } from '../shared/types.ts';
import type { PlatformAdapter } from './adapter.ts';
import { absoluteUrl, elementMedia, isMediaItem } from './dom-utils.ts';

const POST_SELECTOR = 'article, [role="article"]';

export function createFallbackAdapter(platform: Platform, host: string): PlatformAdapter {
  const keyOf = (pathname: string) => `${platform}:url:${pathname}`;
  return {
    platform,
    postSelector: POST_SELECTOR,
    readPost(el) {
      const permalink = [...el.querySelectorAll('a[href]')]
        .map((a) => absoluteUrl(a.getAttribute('href'), a))
        .find((url) => url !== null && new URL(url).host === host);
      const media = [...el.querySelectorAll('img, video')]
        .filter((m) => isMediaItem(m) && m.parentElement?.closest(POST_SELECTOR) === el)
        .flatMap((m) => elementMedia(m, 'video'));
      if (!el.matches(POST_SELECTOR) || !permalink || media.length === 0) {
        return null;
      }
      return { el, postKey: keyOf(new URL(permalink).pathname), sourceKeys: [], authorKey: null, permalink, media };
    },
    focalPostKey: (url) => keyOf(url.pathname),
  };
}
