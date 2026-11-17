// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformAdapter } from '../../src/adapters/adapter.ts';
import type { Platform } from '../../src/shared/types.ts';
import { createFakeBackground, type FakeBackground, okImage, type SeedRecord } from '../helpers/fake-background.ts';
import { createFakeClock, type FakeClock, settle } from '../helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia } from '../helpers/fake-media.ts';
import { createFakeObservers } from '../helpers/fake-observers.ts';
import { DAY_MS, flip, imageFp, randomHashes } from '../helpers/fingerprints.ts';
import { fragment, loadFixture, mediaEls, setUrl } from '../helpers/fixtures.ts';
import { redditImagePost, wykopImageEntry, xPhotoTweet } from '../helpers/platform-markup.ts';

const ADAPTERS: Record<Platform, () => Promise<PlatformAdapter>> = {
  reddit: async () => (await import('../../src/adapters/reddit.ts')).redditAdapter,
  wykop: async () => (await import('../../src/adapters/wykop.ts')).wykopAdapter,
  x: async () => (await import('../../src/adapters/x.ts')).xAdapter,
};
const loadRuntime = () => import('../../src/content/runtime.ts');

const NOW = Date.UTC(2026, 10, 17, 12);
const [HA, HB, HC] = randomHashes(3, 6061);
const WYKOP_A = 'https://wykop.pl/cdn/c3201142/pf-entry-1001,w400.jpg';
const REDDIT_A = 'https://preview.redd.it/pf-base-v0-1pfimg1.png?width=640&crop=smart&auto=webp&s=pf01';
const X_A_RESIZED = 'https://pbs.twimg.com/media/PfPhotoA?format=jpg&name=small';

const shadowRoots = new WeakMap<Element, ShadowRoot>();
const originalAttachShadow = Element.prototype.attachShadow;
let media: FakeMedia;
let running: Array<{ stop(): void }> = [];

beforeEach(() => {
  media = installFakeMedia();
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, init);
    shadowRoots.set(this, root);
    return root;
  };
});

afterEach(() => {
  for (const runtime of running) runtime.stop();
  running = [];
  Element.prototype.attachShadow = originalAttachShadow;
  media.restore();
  document.body.replaceChildren();
});

const isHidden = (el: Element) => el.hasAttribute('data-purefeed-hidden');

function textOf(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== 'STYLE') out += textOf(child);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function indicatorText(post: Element): string {
  const host = [post.previousElementSibling, post.nextElementSibling].find((el) => el?.hasAttribute('data-purefeed-ui'));
  const root = host ? shadowRoots.get(host) : undefined;
  return root ? textOf(root) : '';
}

async function openSession(o: { platform: Platform; url: string; bg: FakeBackground; clock: FakeClock; fixture?: string; container?: string }) {
  setUrl(o.url);
  document.body.replaceChildren();
  if (o.fixture) loadFixture(document, o.fixture);
  if (o.container) document.body.append(fragment(document, o.container));
  const adapter = await ADAPTERS[o.platform]();
  const { createContentRuntime } = await loadRuntime();
  const observers = createFakeObservers();
  const runtime = createContentRuntime({
    adapter,
    doc: document,
    win: window,
    send: o.bg.send,
    createObserver: observers.factory,
    now: o.clock.now,
    setTimer: o.clock.setTimer,
    clearTimer: o.clock.clearTimer,
  });
  running.push(runtime);
  runtime.start();
  await settle();
  const reveal = async (...els: Element[]) => {
    observers.enterLookahead(...els, ...els.flatMap((el) => mediaEls(el)));
    await settle();
  };
  await reveal(...document.querySelectorAll(adapter.postSelector));
  return { runtime, observers, adapter, reveal };
}

describe('cross-platform duplicate detection with the real adapters (AC-029, TC-041)', () => {
  it('should hide the Reddit and X posts of media first seen on Wykop and name Wykop in their indicators (TC-041)', async () => {
    const clock = createFakeClock(NOW);
    const bg = createFakeBackground({
      media: { [WYKOP_A]: okImage(imageFp(HA)), [REDDIT_A]: okImage(imageFp(HA)), [X_A_RESIZED]: okImage(imageFp(flip(HA, 2))) },
      now: clock.now,
    });

    const wykop = await openSession({ platform: 'wykop', url: 'https://wykop.pl/mikroblog', fixture: 'wykop/microblog.html', bg, clock });
    const entry = document.getElementById('thread-1001') as Element;
    wykop.observers.setVisible(entry.querySelector('.photos img') as Element, 1);
    await clock.advance(1000);
    expect(isHidden(entry)).toBe(false);
    expect(bg.rows.map((r) => [r.platform, r.postKey, r.permalink])).toEqual([
      ['wykop', 'wykop:entry:1001', 'https://wykop.pl/wpis/1001/syntetyczny-wpis-ze-zdjeciem'],
    ]);
    wykop.runtime.stop();

    await clock.advance(DAY_MS);
    await openSession({ platform: 'reddit', url: 'https://www.reddit.com/', fixture: 'reddit/home.html', bg, clock });
    const redditPost = document.getElementById('t3_1pfimg1') as Element;
    expect(isHidden(redditPost)).toBe(true);
    expect(indicatorText(redditPost)).toContain('seen on Wykop');
    expect([...document.querySelectorAll('shreddit-post')].filter(isHidden)).toEqual([redditPost]);

    await clock.advance(DAY_MS);
    await openSession({ platform: 'x', url: 'https://x.com/home', fixture: 'x/home.html', bg, clock });
    const tweet = document.querySelector('article[data-testid="tweet"]') as Element;
    expect(isHidden(tweet)).toBe(true);
    expect(indicatorText(tweet)).toContain('seen on Wykop');
    expect([...document.querySelectorAll('article[data-testid="tweet"]')].filter(isHidden)).toEqual([tweet]);
  });
});

type Case = {
  url: string;
  container: string;
  feed: () => Element;
  markup: (id: string, src: string | null) => string;
  post: (root: Element) => Element;
  lazyImages: (post: Element) => Element[];
  recycle: (post: Element, id: string, src: string) => void;
};

const CASES: Record<Platform, Case> = {
  reddit: {
    url: 'https://www.reddit.com/',
    container: '<shreddit-feed></shreddit-feed>',
    feed: () => document.querySelector('shreddit-feed') as Element,
    markup: (id, src) => redditImagePost({ id, author: `pf_${id}`, src }),
    post: (root) => root.querySelector('shreddit-post') as Element,
    lazyImages: (post) => [...post.querySelectorAll('img[data-post-media-primary], img[role="presentation"]')],
    recycle(post, id, src) {
      const next = fragment(document, redditImagePost({ id, author: `pf_${id}`, src })).querySelector('shreddit-post') as Element;
      for (const name of next.getAttributeNames()) post.setAttribute(name, next.getAttribute(name) ?? '');
      post.replaceChildren(...next.childNodes);
    },
  },
  wykop: {
    url: 'https://wykop.pl/mikroblog',
    container: '<section class="listing"><div class="content"></div></section>',
    feed: () => document.querySelector('section.listing > div.content') as Element,
    markup: (id, src) => wykopImageEntry({ id, author: `pf_${id}`, src }),
    post: (root) => root,
    lazyImages: (post) => [...post.querySelectorAll('.photos img')],
    recycle(post, id, src) {
      const next = fragment(document, wykopImageEntry({ id, author: `pf_${id}`, src }));
      post.id = next.id;
      post.replaceChildren(...next.childNodes);
    },
  },
  x: {
    url: 'https://x.com/home',
    container: '<div aria-label="Timeline: Your Home Timeline"><div style="position: relative"></div></div>',
    feed: () => document.querySelector('[aria-label="Timeline: Your Home Timeline"] > div') as Element,
    markup: (id, src) => xPhotoTweet({ id, author: `pf_${id}`, src }),
    post: (root) => root.querySelector('article') as Element,
    lazyImages: (post) => [...post.querySelectorAll('[data-testid="tweetPhoto"] img')],
    recycle(post, id, src) {
      const next = fragment(document, xPhotoTweet({ id, author: `pf_${id}`, src })).querySelector('article') as Element;
      post.replaceChildren(...next.childNodes);
    },
  },
};

const IDS: Record<Platform, [string, string]> = {
  reddit: ['1pfdyn1', '1pfdyn2'],
  wykop: ['7001', '7002'],
  x: ['1860000000000007001', '1860000000000007002'],
};
const SRC: Record<Platform, [string, string]> = {
  reddit: ['https://preview.redd.it/pf-dyn-v0-a.png?width=640', 'https://preview.redd.it/pf-dyn-v0-b.png?width=640'],
  wykop: ['https://wykop.pl/cdn/c3201142/pf-dyn-a,w400.jpg', 'https://wykop.pl/cdn/c3201142/pf-dyn-b,w400.jpg'],
  x: ['https://pbs.twimg.com/media/PfDynA?format=jpg&name=small', 'https://pbs.twimg.com/media/PfDynB?format=jpg&name=small'],
};

function seenB(platform: Platform): SeedRecord {
  const other: Platform = platform === 'wykop' ? 'reddit' : 'wykop';
  return {
    fingerprint: imageFp(HB),
    contentType: 'image',
    platform: other,
    postKey: `${other}:seed`,
    permalink: 'https://wykop.pl/wpis/1/seed',
    firstSeenAt: NOW - DAY_MS,
  };
}

async function expectLazyImageProcessed(platform: Platform) {
  const c = CASES[platform];
  const [id] = IDS[platform];
  const [src] = SRC[platform];
  const clock = createFakeClock(NOW);
  const bg = createFakeBackground({ media: { [src]: okImage(imageFp(HB)) }, seed: [seenB(platform)], now: clock.now });
  const session = await openSession({ platform, url: c.url, container: c.container, bg, clock });
  const root = fragment(document, c.markup(id, null));
  c.feed().append(root);
  await settle();
  const post = c.post(root);
  await session.reveal(post);
  expect(bg.fingerprintUrls()).toEqual([]);
  await clock.advance(1000);
  for (const img of c.lazyImages(post)) img.setAttribute('src', src);
  await settle();
  expect(bg.fingerprintUrls()).toContain(src);
  expect(isHidden(post)).toBe(true);
}

async function expectRecycledElementReprocessed(platform: Platform) {
  const c = CASES[platform];
  const [firstId, nextId] = IDS[platform];
  const [, srcC] = SRC[platform];
  const srcB = SRC[platform][0];
  const clock = createFakeClock(NOW);
  const bg = createFakeBackground({
    media: { [srcB]: okImage(imageFp(HB)), [srcC]: okImage(imageFp(HC)) },
    seed: [seenB(platform)],
    now: clock.now,
  });
  const session = await openSession({ platform, url: c.url, container: c.container, bg, clock });
  const root = fragment(document, c.markup(firstId, srcB));
  c.feed().append(root);
  await settle();
  const post = c.post(root);
  await session.reveal(post);
  expect(isHidden(post)).toBe(true);
  c.recycle(post, nextId, srcC);
  await settle();
  await session.reveal(post);
  expect(bg.fingerprintUrls()).toContain(srcC);
  expect(isHidden(post)).toBe(false);
  expect(session.adapter.readPost(post)?.postKey).toContain(nextId);
}

describe('real adapters in the content runtime: lazy media and recycled elements (AC-045, AC-046, TC-063, TC-065)', () => {
  it('should fingerprint a lazy Reddit image once its src is set and hide the post if the image was seen (TC-063)', async () => {
    await expectLazyImageProcessed('reddit');
  });

  it('should fingerprint a lazy Wykop photo once its src is set and hide the entry if the photo was seen (TC-063)', async () => {
    await expectLazyImageProcessed('wykop');
  });

  it('should fingerprint a lazy X photo once its src is set and hide the tweet if the photo was seen (TC-063)', async () => {
    await expectLazyImageProcessed('x');
  });

  it('should reveal and reprocess a Reddit post element that the feed reuses for another post (TC-065)', async () => {
    await expectRecycledElementReprocessed('reddit');
  });

  it('should reveal and reprocess a Wykop entry element that the list reuses for another entry (TC-065)', async () => {
    await expectRecycledElementReprocessed('wykop');
  });

  it('should reveal and reprocess an X tweet element that the timeline reuses for another tweet (TC-065)', async () => {
    await expectRecycledElementReprocessed('x');
  });
});

const AUTHOR_KEY: Record<Platform, string> = { reddit: 'reddit:u/pf_trusted', wykop: 'wykop:@pf_trusted', x: 'x:@pf_trusted' };
const AUTHOR_IDS: Record<Platform, [string, string, string]> = {
  reddit: ['1pfaut1', '1pfaut2', '1pfaut3'],
  wykop: ['7101', '7102', '7103'],
  x: ['1860000000000007101', '1860000000000007102', '1860000000000007103'],
};

function clickAlwaysShowAuthor(post: Element): void {
  const host = [post.previousElementSibling, post.nextElementSibling].find((el) => el?.hasAttribute('data-purefeed-ui'));
  const root = host ? shadowRoots.get(host) : undefined;
  const button = [...(root?.querySelectorAll('button') ?? [])].find((b) => {
    const text = textOf(b);
    return text.startsWith('Always show ') && text !== 'Always show this post';
  });
  if (!button) throw new Error('no Always show <author> button');
  button.click();
}

async function expectAuthorAlwaysShown(platform: Platform) {
  const c = CASES[platform];
  const [firstId, laterId, otherId] = AUTHOR_IDS[platform];
  const [srcA, srcB] = SRC[platform];
  const clock = createFakeClock(NOW);
  const bg = createFakeBackground({
    media: { [srcA]: okImage(imageFp(HB)), [srcB]: okImage(imageFp(flip(HB, 1))) },
    seed: [seenB(platform)],
    now: clock.now,
  });
  const session = await openSession({ platform, url: c.url, container: c.container, bg, clock });
  const firstRoot = fragment(document, c.markup(firstId, srcA).replaceAll(`pf_${firstId}`, 'pf_trusted'));
  c.feed().append(firstRoot);
  await settle();
  const first = c.post(firstRoot);
  await session.reveal(first);
  expect(isHidden(first)).toBe(true);
  clickAlwaysShowAuthor(first);
  await settle();
  expect(bg.of('whitelist/add').map((r) => r.entry)).toEqual([{ type: 'source', key: AUTHOR_KEY[platform] }]);
  expect(isHidden(first)).toBe(false);
  const laterRoot = fragment(document, c.markup(laterId, srcB).replaceAll(`pf_${laterId}`, 'pf_trusted'));
  const otherRoot = fragment(document, c.markup(otherId, srcB));
  c.feed().append(laterRoot, otherRoot);
  await settle();
  const [later, other] = [c.post(laterRoot), c.post(otherRoot)];
  await session.reveal(later, other);
  expect(session.adapter.readPost(later)?.sourceKeys).toContain(AUTHOR_KEY[platform]);
  expect([isHidden(later), isHidden(other)]).toEqual([false, true]);
}

describe('real adapters in the content runtime: Always show <author> (AC-055, TC-074)', () => {
  for (const platform of ['reddit', 'wykop', 'x'] as const) {
    it(`should whitelist the ${platform} author and keep a later post of that author with seen media visible (TC-074)`, async () => {
      await expectAuthorAlwaysShown(platform);
    });
  }
});
