// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBackground, okImage, type SeedRecord } from '../../test/helpers/fake-background.ts';
import { createFakeClock, settle } from '../../test/helpers/fake-ext.ts';
import { createFakeObservers, setLayout } from '../../test/helpers/fake-observers.ts';
import { DAY_MS, imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import { fragment, loadFixture, mediaEls, setUrl } from '../../test/helpers/fixtures.ts';
import type { PlatformAdapter } from './adapter.ts';

const loadFallback = () => import('./generic-fallback.ts');
const loadRuntime = () => import('../content/runtime.ts');
const loadReddit = async (): Promise<PlatformAdapter> => (await import('./reddit.ts')).redditAdapter;

const NOW = Date.UTC(2026, 10, 17, 12);
const [H1, H2, H3] = randomHashes(3, 4817);
const R1 = 'https://preview.redd.it/pf-renamed-v0-r1.png?width=640&crop=smart&auto=webp&s=pfr1';
const R2 = 'https://preview.redd.it/pf-renamed-v0-r2.png?width=640&crop=smart&auto=webp&s=pfr2';
const R3 = 'https://preview.redd.it/pf-renamed-v0-r3.png?width=640&crop=smart&auto=webp&s=pfr3';
const MEDIA = { [R1]: okImage(imageFp(H1)), [R2]: okImage(imageFp(H2)), [R3]: okImage(imageFp(H3)) };
const SEEN_R2_ON_WYKOP: SeedRecord = {
  fingerprint: imageFp(H2),
  contentType: 'image',
  platform: 'wykop',
  postKey: 'wykop:entry:777',
  permalink: 'https://wykop.pl/wpis/777/syntetyczny',
  firstSeenAt: NOW - DAY_MS,
};

let running: Array<{ stop(): void }> = [];

beforeEach(() => {
  setUrl('https://www.reddit.com/');
});

afterEach(() => {
  for (const runtime of running) runtime.stop();
  running = [];
  document.body.replaceChildren();
});

const articles = () => [...document.querySelectorAll('shreddit-feed > article')];
const isHidden = (el: Element) => el.hasAttribute('data-purefeed-hidden');

async function startRuntime(adapter: PlatformAdapter) {
  const { createContentRuntime } = await loadRuntime();
  const clock = createFakeClock(NOW);
  const observers = createFakeObservers();
  const bg = createFakeBackground({ media: MEDIA, seed: [SEEN_R2_ON_WYKOP], now: clock.now });
  const runtime = createContentRuntime({
    adapter,
    doc: document,
    win: window,
    send: bg.send,
    createObserver: observers.factory,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  running.push(runtime);
  runtime.start();
  await settle();
  observers.enterLookahead(...articles(), ...mediaEls(document.body));
  await settle();
  return { clock, bg };
}

describe('generic fallback adapter (AC-048)', () => {
  it('should treat the nearest article of a media item as the post with key from its first same-host permalink', async () => {
    const { createFallbackAdapter } = await loadFallback();
    loadFixture(document, 'generic/renamed-reddit.html');
    const adapter: PlatformAdapter = createFallbackAdapter('reddit', 'www.reddit.com');
    const [first] = articles();
    const post = adapter.readPost(first);
    expect(adapter.platform).toBe('reddit');
    expect(first.matches(adapter.postSelector)).toBe(true);
    expect(post?.el).toBe(first);
    expect(post?.postKey).toBe('reddit:url:/r/pf_memes/comments/1pfren1/synthetic_renamed_one/');
    expect(post?.permalink).toBe('https://www.reddit.com/r/pf_memes/comments/1pfren1/synthetic_renamed_one/');
    expect(post?.media.map((m) => m.el)).toEqual([first.querySelector('img[data-post-media-primary]')]);
    expect(post?.media[0]?.contentType).toBe('image');
  });

  it('should treat an element with role article as the post too', async () => {
    const { createFallbackAdapter } = await loadFallback();
    const el = fragment(
      document,
      `<div role="article"><a href="https://x.com/pf_role/status/1860000000000000555">Synthetic</a>
        <img src="https://pbs.twimg.com/media/PfRole?format=jpg&amp;name=small" style="width: 400px; height: 300px" /></div>`,
    );
    document.body.append(el);
    setUrl('https://x.com/home');
    const adapter: PlatformAdapter = createFallbackAdapter('x', 'x.com');
    const post = adapter.readPost(el);
    expect(el.matches(adapter.postSelector)).toBe(true);
    expect(post?.postKey).toBe('x:url:/pf_role/status/1860000000000000555');
    expect(post?.media.map((m) => m.el)).toEqual([el.querySelector('img')]);
  });
});

describe('content runtime generic fallback switch (AC-048, TC-067)', () => {
  it('should switch to the fallback after 10 s without adapter posts, hide posts with seen media and log 1 warning (TC-067)', async () => {
    loadFixture(document, 'generic/renamed-reddit.html');
    const { clock, bg } = await startRuntime(await loadReddit());
    await clock.advance(9000);
    expect(articles().some(isHidden)).toBe(false);
    expect(bg.of('log/warn')).toHaveLength(0);
    await clock.advance(2000);
    expect(articles().map(isHidden)).toEqual([false, true, false]);
    expect(bg.of('log/warn')).toHaveLength(1);
    await clock.advance(30_000);
    expect(bg.of('log/warn')).toHaveLength(1);
  });

  it('should not switch to the fallback if fewer than 3 media items show', async () => {
    loadFixture(document, 'generic/renamed-reddit.html');
    articles()[2].remove();
    const { clock, bg } = await startRuntime(await loadReddit());
    await clock.advance(15_000);
    expect(bg.of('log/warn')).toHaveLength(0);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(articles().some(isHidden)).toBe(false);
  });

  it('should not switch to the fallback while the adapter finds posts', async () => {
    loadFixture(document, 'reddit/home.html');
    const { clock, bg } = await startRuntime(await loadReddit());
    await clock.advance(15_000);
    expect(bg.fingerprintUrls().length).toBeGreaterThan(0);
    expect(bg.of('log/warn')).toHaveLength(0);
  });
});

describe('content runtime generic fallback boundaries (AC-048)', () => {
  const primaryImages = () => [...document.querySelectorAll('img[data-post-media-primary]')];

  it('should switch to the fallback exactly 10 s after start and not 1 ms earlier', async () => {
    loadFixture(document, 'generic/renamed-reddit.html');
    const { clock, bg } = await startRuntime(await loadReddit());
    await clock.advance(9_999);
    expect(bg.of('log/warn')).toHaveLength(0);
    expect(bg.fingerprintUrls()).toEqual([]);
    await clock.advance(1);
    expect(bg.of('log/warn')).toHaveLength(1);
    expect(articles().map(isHidden)).toEqual([false, true, false]);
  });

  for (const [width, height] of [
    [149, 540],
    [545, 149],
    [149, 149],
  ]) {
    it(`should not switch to the fallback if the third media item renders at ${width} x ${height} CSS px`, async () => {
      loadFixture(document, 'generic/renamed-reddit.html');
      setLayout(primaryImages()[2], { top: 1200, width, height });
      const { clock, bg } = await startRuntime(await loadReddit());
      await clock.advance(30_000);
      expect(bg.of('log/warn')).toHaveLength(0);
      expect(bg.fingerprintUrls()).toEqual([]);
    });
  }

  it('should switch to the fallback if the third media item renders at exactly 150 x 150 CSS px', async () => {
    loadFixture(document, 'generic/renamed-reddit.html');
    setLayout(primaryImages()[2], { top: 1200, width: 150, height: 150 });
    const { clock, bg } = await startRuntime(await loadReddit());
    await clock.advance(10_000);
    expect(bg.of('log/warn')).toHaveLength(1);
    expect(bg.fingerprintUrls()).toEqual([R1, R2, R3]);
  });
});
