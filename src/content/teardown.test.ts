// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackground, okImage, type SeedRecord } from '../../test/helpers/fake-background.ts';
import { createFakeClock, createFakeExt, settle } from '../../test/helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../../test/helpers/fake-media.ts';
import { createFakeObservers, type FakeObservers } from '../../test/helpers/fake-observers.ts';
import { DAY_MS, imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import { fragment, mediaEls, setUrl } from '../../test/helpers/fixtures.ts';
import { redditImagePost } from '../../test/helpers/platform-markup.ts';
import { createTestAdapter, makeFeed, mediaOf } from '../../test/helpers/test-adapter.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';

const NOW = Date.UTC(2026, 10, 17, 12);
const [HA] = randomHashes(1, 5060);
const IMG_A = 'https://preview.redd.it/pf-teardown-v0-a.png?width=640';
const IMG_B = 'https://preview.redd.it/pf-teardown-v0-b.png?width=640';
const CLIP_BLOB = 'blob:https://www.reddit.com/7ea2d000-0000-4000-8000-000000000001';
const SEEN_A: SeedRecord = {
  fingerprint: imageFp(HA),
  contentType: 'image',
  platform: 'wykop',
  postKey: 'wykop:entry:5060',
  permalink: 'https://wykop.pl/wpis/5060/syntetyczny',
  firstSeenAt: NOW - DAY_MS,
};

type LiveTimer = { kind: 'timeout' | 'interval'; ms: number; site: string };

const SOURCE_FRAME = /\/src\/[\w/.-]+?(?<!\.test)\.ts:\d+/;

function trackSourceTimers() {
  const live = new Map<unknown, LiveTimer>();
  const original = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  const siteOf = (): string | null => SOURCE_FRAME.exec(new Error().stack?.split('\n').slice(2).join('\n') ?? '')?.[0] ?? null;
  const clear = (handle: unknown) => {
    live.delete(handle);
    if (handle !== null && typeof handle === 'object') live.delete(Number(handle));
  };
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const site = siteOf();
    const handle: unknown = original.setTimeout(
      (...a: unknown[]) => {
        live.delete(handle);
        fn(...a);
      },
      ms,
      ...args,
    );
    if (site) live.set(handle, { kind: 'timeout', ms: ms ?? 0, site });
    return handle;
  }) as typeof setTimeout;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const site = siteOf();
    const handle = original.setInterval(fn, ms, ...args);
    if (site) live.set(handle, { kind: 'interval', ms: ms ?? 0, site });
    return handle;
  }) as typeof setInterval;
  globalThis.clearTimeout = ((handle: unknown) => {
    clear(handle);
    original.clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((handle: unknown) => {
    clear(handle);
    original.clearInterval(handle as Parameters<typeof clearInterval>[0]);
  }) as typeof clearInterval;
  return {
    live: (): LiveTimer[] => [...live.values()],
    restore() {
      for (const handle of live.keys()) original.clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      live.clear();
      Object.assign(globalThis, original);
    },
  };
}

function trackedClock() {
  const clock = createFakeClock(NOW);
  const pending = new Set<unknown>();
  return {
    ...clock,
    setTimer(fn: () => void, ms: number) {
      const id = clock.setTimer(() => {
        pending.delete(id);
        fn();
      }, ms);
      pending.add(id);
      return id;
    },
    clearTimer(id: unknown) {
      pending.delete(id);
      clock.clearTimer(id);
    },
    pending: () => pending.size,
  };
}

let timers: ReturnType<typeof trackSourceTimers>;
let media: FakeMedia;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  setUrl('https://www.reddit.com/');
  media = installFakeMedia();
  media.addVideo(CLIP_BLOB, videoFromAsset('clip.mp4'));
  timers = trackSourceTimers();
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  timers.restore();
  media.restore();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

async function within(ms: number, check: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    await settle();
    if (check()) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('content runtime teardown (AC-047, plan 5.6 extension reload)', () => {
  it('should leave no URL watcher interval and no pending timer if the content runtime stops', async () => {
    const { createContentRuntime } = await import('./runtime.ts');
    const clock = trackedClock();
    const observers = createFakeObservers();
    const bg = createFakeBackground({ media: { [IMG_A]: okImage(imageFp(HA)) }, seed: [SEEN_A], now: clock.now });
    const { posts } = makeFeed(document, [
      { id: 'td1', top: 0, media: [{ kind: 'img', src: IMG_A, width: 600, height: 400 }] },
      { id: 'td2', top: 500, media: [{ kind: 'video', src: CLIP_BLOB, width: 640, height: 360 }] },
    ]);
    const runtime = createContentRuntime({
      adapter: createTestAdapter('reddit'),
      doc: document,
      win: window,
      send: bg.send,
      createObserver: observers.factory,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    cleanups.push(() => runtime.stop());
    runtime.start();
    await settle();
    observers.enterLookahead(...posts, ...posts.map(mediaOf));
    await settle();
    observers.setVisible(mediaOf(posts[0]), 1);
    observers.setVisible(mediaOf(posts[1]), 1);
    await settle();

    runtime.stop();
    await settle();

    expect(timers.live()).toEqual([]);
    expect(clock.pending()).toBe(0);
    history.pushState({}, '', '/r/pf_after_stop/');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(timers.live()).toEqual([]);
  });

  it('should stop the URL watcher and every timer of the content script if the extension context is invalidated', async () => {
    const ext = createFakeExt();
    await ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    const bg = createFakeBackground({ media: { [IMG_A]: okImage(imageFp(HA)), [IMG_B]: okImage(imageFp(HA)) }, seed: [SEEN_A], now: Date.now });
    const observers: FakeObservers = createFakeObservers();
    const chrome = {
      runtime: {
        id: 'purefeed-test' as string | undefined,
        sendMessage: (req: Parameters<typeof bg.send>[0]) => {
          if (chrome.runtime.id === undefined) throw new Error('Extension context invalidated.');
          return bg.send(req);
        },
        onMessage: { addListener() {}, removeListener() {} },
        getURL: (path: string) => `chrome-extension://purefeed-test/${path}`,
      },
      storage: { local: ext.storage.local, onChanged: ext.storage.onChanged },
      alarms: ext.alarms,
    };
    cleanups.push(() => {
      chrome.runtime.id = undefined;
    });
    const root = fragment(document, redditImagePost({ id: '1pftd01', author: 'pf_td', src: IMG_A }));
    document.body.append(root);
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
    const post = root.querySelector('shreddit-post') as Element;
    observers.enterLookahead(post, ...mediaEls(post));
    expect(await within(1000, () => post.hasAttribute('data-purefeed-hidden'))).toBe(true);
    observers.setVisible(post.querySelector('img[data-post-media-primary]') as Element, 1);
    await settle();

    chrome.runtime.id = undefined;
    history.pushState({}, '', '/r/pf_after_reload/');
    const late = fragment(document, redditImagePost({ id: '1pftd02', author: 'pf_td', src: IMG_B }));
    document.body.append(late);
    await settle();
    observers.enterLookahead(late, ...mediaEls(late));

    await within(2000, () => timers.live().length === 0);
    expect(timers.live()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(timers.live()).toEqual([]);
  });
});
