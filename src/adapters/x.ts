import type { PlatformAdapter } from './adapter.ts';
import { absoluteUrl, elementMedia } from './dom-utils.ts';

const POST_SELECTOR = 'article[data-testid="tweet"]';
const STATUS_PATH = /^\/([^/?#]+)\/status\/(\d+)/;
const MEDIA_SELECTOR = '[data-testid="tweetPhoto"] img, [data-testid="videoPlayer"] video';
const GIF_VIDEO_PREFIX = 'https://video.twimg.com/tweet_video/';
const GIF_BADGE = 'GIF';

const statusKey = (pathname: string): string | null => {
  const id = STATUS_PATH.exec(pathname)?.[2];
  return id === undefined ? null : `x:${id}`;
};

const hasGifBadge = (video: Element): boolean =>
  [...(video.closest('[data-testid="videoPlayer"]')?.querySelectorAll('span') ?? [])].some((span) => span.textContent?.trim() === GIF_BADGE);

const isGif = (media: Element): boolean => (media.getAttribute('src') ?? '').startsWith(GIF_VIDEO_PREFIX) || hasGifBadge(media);

export const xAdapter: PlatformAdapter = {
  platform: 'x',
  postSelector: POST_SELECTOR,
  readPost(el) {
    const href = [...el.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time') !== null)?.getAttribute('href');
    const permalink = absoluteUrl(href, el);
    const match = STATUS_PATH.exec(permalink === null ? '' : new URL(permalink).pathname);
    const postKey = match ? `x:${match[2]}` : null;
    const focal = statusKey(new URL(el.ownerDocument.URL).pathname);
    if (!el.matches(POST_SELECTOR) || !match || postKey === null || permalink === null || (focal !== null && focal !== postKey)) {
      return null;
    }
    const authorKey = `x:@${match[1]}`;
    return {
      el,
      postKey,
      sourceKeys: [authorKey],
      authorKey,
      permalink,
      media: [...el.querySelectorAll(MEDIA_SELECTOR)].flatMap((media) => elementMedia(media, isGif(media) ? 'gif' : 'video')),
    };
  },
  focalPostKey: (url) => statusKey(url.pathname),
};
