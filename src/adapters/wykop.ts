import type { DetectedMedia, DetectedPost, PlatformAdapter } from './adapter.ts';
import { absoluteUrl, elementMedia, firstMatch } from './dom-utils.ts';

const ENTRY_SELECTOR = 'section.thread[data-level="1"]';
const LINK_SELECTOR = 'section.link-block';
const AUTHOR = /^\/ludzie\/([^/?#]+)/;
const ENTRY_PATH = /^\/wpis\/(\d+)(?:\/|$)/;
const LINK_PATH = /^\/link\/(\d+)(?:\/|$)/;
const ENTRY_MEDIA_SELECTOR = ':scope > section.item > .media .photos img, :scope > section.item > .media video';

type Kind = { selector: string; path: RegExp; key: string; anchor: string; author: string; media: (el: Element) => DetectedMedia[] };

const KINDS: readonly Kind[] = [
  {
    selector: ENTRY_SELECTOR,
    path: ENTRY_PATH,
    key: 'entry',
    anchor: ':scope > section.item > header a[href^="/wpis/"]',
    author: ':scope > section.item > header a.username[href^="/ludzie/"]',
    media: (el) => [...el.querySelectorAll(ENTRY_MEDIA_SELECTOR)].flatMap((media) => elementMedia(media, 'video')),
  },
  {
    selector: LINK_SELECTOR,
    path: LINK_PATH,
    key: 'link',
    anchor: 'article header a[href^="/link/"]',
    author: 'article a.username[href^="/ludzie/"]',
    media: () => [],
  },
];

function readPost(el: Element): DetectedPost | null {
  const kind = KINDS.find((k) => el.matches(k.selector));
  const href = kind ? el.querySelector(kind.anchor)?.getAttribute('href') : null;
  const id = kind ? firstMatch(kind.path, href) : null;
  const permalink = absoluteUrl(href, el);
  if (!kind || id === null || permalink === null) {
    return null;
  }
  const author = firstMatch(AUTHOR, el.querySelector(kind.author)?.getAttribute('href'));
  const authorKey = author === null ? null : `wykop:@${author}`;
  return {
    el,
    postKey: `wykop:${kind.key}:${id}`,
    sourceKeys: authorKey === null ? [] : [authorKey],
    authorKey,
    permalink,
    media: kind.media(el),
  };
}

export const wykopAdapter: PlatformAdapter = {
  platform: 'wykop',
  postSelector: `${ENTRY_SELECTOR}, ${LINK_SELECTOR}`,
  readPost,
  focalPostKey(url) {
    const kind = KINDS.find((k) => k.path.test(url.pathname));
    return kind ? `wykop:${kind.key}:${firstMatch(kind.path, url.pathname)}` : null;
  },
};
