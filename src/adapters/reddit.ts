import type { DetectedMedia, PlatformAdapter } from './adapter.ts';
import { absoluteUrl, firstMatch, imageMedia, isImage } from './dom-utils.ts';

const POST_ID = /^(t3_[a-z0-9]+)$/i;
const FOCAL_PATH = /^\/r\/[^/]+\/comments\/([a-z0-9]+)(?:\/|$)/i;
const POST_SELECTOR = 'shreddit-post';
const MEDIA_SELECTOR = ['img[data-post-media-primary]', 'gallery-carousel li figure > img', 'shreddit-player']
  .map((media) => `[slot="post-media-container"] ${media}`)
  .join(', ');
const PLAYER_SELECTOR = '[slot="post-media-container"] shreddit-player';

function readMedia(el: Element): DetectedMedia[] {
  if (isImage(el)) {
    return [imageMedia(el)];
  }
  const video = el.shadowRoot?.querySelector('video');
  if (!video) {
    return [];
  }
  return [
    {
      el: video,
      contentType: el.hasAttribute('gif') ? 'gif' : 'video',
      posterUrl: absoluteUrl(video.getAttribute('poster') ?? el.getAttribute('poster'), video),
    },
  ];
}

export const redditAdapter: PlatformAdapter = {
  platform: 'reddit',
  postSelector: POST_SELECTOR,
  lateMediaHostSelector: PLAYER_SELECTOR,
  readPost(el) {
    const id = firstMatch(POST_ID, el.id);
    const permalink = absoluteUrl(el.getAttribute('permalink'), el);
    if (!el.matches(POST_SELECTOR) || id === null || permalink === null) {
      return null;
    }
    const author = el.getAttribute('author');
    const subreddit = el.getAttribute('subreddit-prefixed-name');
    const authorKey = author ? `reddit:u/${author}` : null;
    return {
      el,
      postKey: `reddit:${id}`,
      sourceKeys: [authorKey, subreddit ? `reddit:${subreddit}` : null].filter((key): key is string => key !== null),
      authorKey,
      permalink,
      media: [...el.querySelectorAll(MEDIA_SELECTOR)].flatMap(readMedia),
    };
  },
  focalPostKey(url) {
    const id = firstMatch(FOCAL_PATH, url.pathname);
    return id === null ? null : `reddit:t3_${id}`;
  },
};
