// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackground, type FakeBackground, okImage, type SeedRecord } from '../../test/helpers/fake-background.ts';
import { createFakeExt, type FakeExt, settle } from '../../test/helpers/fake-ext.ts';
import { createFakeObservers, type FakeObservers } from '../../test/helpers/fake-observers.ts';
import { DAY_MS, imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import { fragment, mediaEls, setUrl } from '../../test/helpers/fixtures.ts';
import { redditImagePost, wykopImageEntry, xPhotoTweet } from '../../test/helpers/platform-markup.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import type { Platform, Settings, WhitelistEntry } from '../shared/types.ts';

const [HA] = randomHashes(1, 9049);
const SEEN_A: SeedRecord = {
  fingerprint: imageFp(HA),
  contentType: 'image',
  platform: 'wykop',
  postKey: 'wykop:entry:900',
  permalink: 'https://wykop.pl/wpis/900/syntetyczny',
  firstSeenAt: Date.now() - DAY_MS,
};

const PAGES: Record<Platform, { url: string; src: string; markup: (src: string) => string; post: (root: Element) => Element }> = {
  reddit: {
    url: 'https://www.reddit.com/',
    src: 'https://preview.redd.it/pf-gate-v0-a.png?width=640',
    markup: (src) => redditImagePost({ id: '1pfgate', author: 'pf_gate', src }),
    post: (root) => root.querySelector('shreddit-post') as Element,
  },
  wykop: {
    url: 'https://wykop.pl/mikroblog',
    src: 'https://wykop.pl/cdn/c3201142/pf-gate-a,w400.jpg',
    markup: (src) => wykopImageEntry({ id: '8001', author: 'pf_gate', src }),
    post: (root) => root,
  },
  x: {
    url: 'https://x.com/home',
    src: 'https://pbs.twimg.com/media/PfGateA?format=jpg&name=small',
    markup: (src) => xPhotoTweet({ id: '1860000000000008001', author: 'pf_gate', src }),
    post: (root) => root.querySelector('article') as Element,
  },
};

type Page = {
  ext: FakeExt;
  bg: FakeBackground;
  observers: FakeObservers;
  post: Element;
  others: Element[];
  chrome: { runtime: { id: string | undefined } };
};
type PageExtras = { whitelist?: WhitelistEntry[]; others?: string[] };
let pages: Page[] = [];

afterEach(() => {
  for (const page of pages) page.chrome.runtime.id = undefined;
  pages = [];
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

const withSettings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const platformOff = (platform: Platform): Settings => withSettings({ platforms: { ...DEFAULT_SETTINGS.platforms, [platform]: false } });
const isHidden = (el: Element) => el.hasAttribute('data-purefeed-hidden');

async function within(ms: number, check: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    await settle();
    if (check()) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openPage(platform: Platform, url: string, settings: Settings, extras: PageExtras = {}): Promise<Page> {
  setUrl(url);
  const spec = PAGES[platform];
  const root = fragment(document, spec.markup(spec.src));
  const otherRoots = (extras.others ?? []).map((markup) => fragment(document, markup));
  document.body.append(root, ...otherRoots);
  const ext = createFakeExt();
  await ext.storage.local.set({ settings, ...(extras.whitelist ? { whitelist: extras.whitelist } : {}) });
  const bg = createFakeBackground({ media: { [spec.src]: okImage(imageFp(HA)) }, seed: [SEEN_A], now: Date.now });
  const observers = createFakeObservers();
  const chrome = {
    runtime: {
      id: 'purefeed-test' as string | undefined,
      sendMessage: (req: Parameters<typeof bg.send>[0]) => bg.send(req),
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path: string) => `chrome-extension://purefeed-test/${path}`,
    },
    storage: { local: ext.storage.local, onChanged: ext.storage.onChanged },
    alarms: ext.alarms,
  };
  vi.stubGlobal('__TARGET__', 'chrome');
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      readonly handle: ReturnType<FakeObservers['factory']>;
      constructor(cb: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.handle = observers.factory(cb, init);
      }
      observe(el: Element) {
        this.handle.observe(el);
      }
      unobserve(el: Element) {
        this.handle.unobserve(el);
      }
      disconnect() {
        this.handle.disconnect();
      }
    },
  );
  await settle();
  await import('./main.ts');
  await settle();
  const post = spec.post(root);
  const others = otherRoots.map(spec.post);
  observers.enterLookahead(...[post, ...others].flatMap((el) => [el, ...mediaEls(el)]));
  await settle();
  const page = { ext, bg, observers, post, others, chrome };
  pages.push(page);
  return page;
}

describe('content script platform gating (AC-049, TC-068)', () => {
  it('should run nothing on old.reddit.com and run the Reddit adapter on www.reddit.com', async () => {
    const old = await openPage('reddit', 'https://old.reddit.com/', DEFAULT_SETTINGS);
    await within(300, () => false);
    expect(old.bg.requests).toEqual([]);
    expect(old.observers.observers).toEqual([]);
    expect(isHidden(old.post)).toBe(false);
    document.body.replaceChildren();
    vi.resetModules();
    const { bg, post } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS);
    expect(await within(1000, () => isHidden(post))).toBe(true);
    expect(bg.fingerprintUrls()).toEqual([PAGES.reddit.src]);
  });

  it('should run no fingerprint job on Reddit while the Reddit toggle is off and process the feed within 1 s after it is turned on (TC-068)', async () => {
    const { ext, bg, post } = await openPage('reddit', PAGES.reddit.url, platformOff('reddit'));
    await within(300, () => false);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(isHidden(post)).toBe(false);
    await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    expect(await within(1000, () => isHidden(post))).toBe(true);
  });

  it('should run no fingerprint job on Wykop while the Wykop toggle is off and process the feed within 1 s after it is turned on (TC-068)', async () => {
    const { ext, bg, post } = await openPage('wykop', PAGES.wykop.url, platformOff('wykop'));
    await within(300, () => false);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(isHidden(post)).toBe(false);
    await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    expect(await within(1000, () => isHidden(post))).toBe(true);
  });

  it('should run no fingerprint job on X while the X toggle is off and process the feed within 1 s after it is turned on (TC-068)', async () => {
    const { ext, bg, post } = await openPage('x', PAGES.x.url, platformOff('x'));
    await within(300, () => false);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(isHidden(post)).toBe(false);
    await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    expect(await within(1000, () => isHidden(post))).toBe(true);
  });

  it('should keep Wykop processing if only another platform toggle is off', async () => {
    const { post } = await openPage('wykop', PAGES.wykop.url, platformOff('reddit'));
    expect(await within(1000, () => isHidden(post))).toBe(true);
  });

  it('should stay idle while deduplication is off and process the feed within 1 s after it is turned on', async () => {
    const { ext, bg, post } = await openPage('x', PAGES.x.url, withSettings({ enabled: false }));
    await within(300, () => false);
    expect(bg.fingerprintUrls()).toEqual([]);
    await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    expect(await within(1000, () => isHidden(post))).toBe(true);
  });

  it('should reveal a hidden post within 1 s if its platform toggle is turned off (AC-065)', async () => {
    const { ext, post } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS);
    expect(await within(1000, () => isHidden(post))).toBe(true);
    await ext.storage.local.set({ settings: platformOff('reddit') });
    expect(await within(1000, () => !isHidden(post))).toBe(true);
  });
});

describe('stored whitelist in a new page session (AC-054, AC-055, AC-056, TC-073, TC-075)', () => {
  const TRUSTED_AUTHOR = redditImagePost({ id: '1pfauth', author: 'pf_trusted', src: PAGES.reddit.src });
  const TRUSTED_SUB = redditImagePost({ id: '1pfsub', author: 'pf_member', sub: 'pf_trusted_sub', src: PAGES.reddit.src });
  const CONTROL = redditImagePost({ id: '1pfctrl', author: 'pf_other', src: PAGES.reddit.src });
  const WHITELIST: WhitelistEntry[] = [
    { type: 'post', key: 'reddit:t3_1pfgate' },
    { type: 'source', key: 'reddit:u/pf_trusted' },
    { type: 'source', key: 'reddit:r/pf_trusted_sub' },
  ];

  it('should keep the whitelisted post, author and subreddit posts visible and hide the other post if the page loads with a stored whitelist', async () => {
    const { post, others } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS, {
      whitelist: WHITELIST,
      others: [TRUSTED_AUTHOR, TRUSTED_SUB, CONTROL],
    });
    const [author, sub, control] = others;
    expect(await within(1000, () => isHidden(control))).toBe(true);
    expect([post, author, sub].map(isHidden)).toEqual([false, false, false]);
  });

  it('should record the media of a whitelisted post as seen if it stays in view for 1 s (AC-054)', async () => {
    const { bg, observers, post, others } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS, {
      whitelist: WHITELIST,
      others: [CONTROL],
    });
    expect(await within(1000, () => isHidden(others[0]))).toBe(true);
    for (const el of mediaEls(post)) observers.setVisible(el, 1);
    expect(await within(2000, () => bg.of('seen/record').some((r) => r.sighting.postKey === 'reddit:t3_1pfgate'))).toBe(true);
    expect(isHidden(post)).toBe(false);
    expect(bg.rows.find((row) => row.recordId === 'seed-0')?.count).toBe(2);
  });

  it('should hide every post again in the next page session if the whitelist entries are removed (TC-075)', async () => {
    await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS, { whitelist: WHITELIST, others: [TRUSTED_SUB] });
    document.body.replaceChildren();
    vi.resetModules();
    const { post, others } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS, { whitelist: [], others: [TRUSTED_SUB] });
    expect(await within(1000, () => [post, ...others].every(isHidden))).toBe(true);
  });
});

describe('content type toggle through storage.onChanged (AC-066, TC-086)', () => {
  it('should reveal an image post within 1 s and fingerprint no later image if the image toggle is turned off', async () => {
    const { ext, bg, observers, post } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS);
    expect(await within(1000, () => isHidden(post))).toBe(true);
    await ext.storage.local.set({ settings: withSettings({ contentTypes: { ...DEFAULT_SETTINGS.contentTypes, image: false } }) });
    expect(await within(1000, () => !isHidden(post))).toBe(true);
    const laterRoot = fragment(document, redditImagePost({ id: '1pflater', author: 'pf_late', src: PAGES.reddit.src.replace('-a.', '-b.') }));
    document.body.append(laterRoot);
    await settle();
    const later = PAGES.reddit.post(laterRoot);
    observers.enterLookahead(later, ...mediaEls(later));
    await within(300, () => false);
    expect(bg.fingerprintUrls()).toEqual([PAGES.reddit.src]);
  });
});

describe('no new processing after a toggle goes off (AC-063, AC-065)', () => {
  const OFF: Array<[string, Settings]> = [
    ['master toggle', withSettings({ enabled: false })],
    ['Reddit toggle', platformOff('reddit')],
  ];
  for (const [name, off] of OFF) {
    it(`should send no request for a post inserted or viewed after the ${name} goes off and process it within 1 s after it goes on`, async () => {
      const { ext, bg, observers, post } = await openPage('reddit', PAGES.reddit.url, DEFAULT_SETTINGS);
      expect(await within(1000, () => isHidden(post))).toBe(true);
      await ext.storage.local.set({ settings: off });
      expect(await within(1000, () => !isHidden(post))).toBe(true);
      const sent = bg.requests.length;
      const laterSrc = PAGES.reddit.src.replace('-a.', '-c.');
      const laterRoot = fragment(document, redditImagePost({ id: '1pfoff', author: 'pf_off', src: laterSrc }));
      document.body.append(laterRoot);
      await settle();
      const later = PAGES.reddit.post(laterRoot);
      observers.enterLookahead(later, ...mediaEls(later));
      for (const el of [post, later].flatMap(mediaEls)) observers.setVisible(el, 1);
      await within(1500, () => false);
      expect(bg.requests.slice(sent)).toEqual([]);
      await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
      expect(await within(1000, () => bg.fingerprintUrls().includes(laterSrc))).toBe(true);
    });
  }
});
