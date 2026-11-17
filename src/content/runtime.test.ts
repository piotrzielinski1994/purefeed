// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import { createFakeClock, settle } from '../../test/helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../../test/helpers/fake-media.ts';
import { createFakeObservers } from '../../test/helpers/fake-observers.ts';
import { DAY_MS, DEFAULT_THRESHOLDS, flip, imageFp, posterFp, randomHashes } from '../../test/helpers/fingerprints.ts';
import { createTestAdapter, makeFeed, makePost, mediaOf, type PostSpec, permalinkOf } from '../../test/helpers/test-adapter.ts';
import type { sendRequest } from '../compat/messaging.ts';
import { fingerprintSequence } from '../fingerprint/frame-sequence.ts';
import type { Request } from '../shared/messages.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import type { ContentType, DecodeResult, Fingerprint, Platform, SeenMatch, Settings } from '../shared/types.ts';
import { decodeFingerprint, decodeGrayFrame, encodeDecodeResult, type WireGrayFrame } from '../shared/wire.ts';
import { compareFingerprints } from '../similarity/compare.ts';

const loadRuntime = () => import('./runtime.ts');

const NOW = Date.UTC(2026, 10, 17, 12);
const [HA, HB, HC, HD, HE] = randomHashes(5, 2026);
const IMG = {
  a: 'https://i.redd.it/a.png',
  aCopy: 'https://preview.redd.it/a.png?width=640&format=pjpg',
  b: 'https://i.redd.it/b.png',
  c: 'https://i.redd.it/c.png',
  d: 'https://i.redd.it/d.png',
  e: 'https://i.redd.it/e.png',
};
const CLIP_BLOB = 'blob:https://www.reddit.com/0b0f5c1e-0000-4000-8000-000000000001';
const CLIP_BLOB_2 = 'blob:https://www.reddit.com/0b0f5c1e-0000-4000-8000-000000000002';
const INTRO_BLOB_A = 'blob:https://www.reddit.com/0b0f5c1e-0000-4000-8000-000000000003';
const INTRO_BLOB_B = 'blob:https://www.reddit.com/0b0f5c1e-0000-4000-8000-000000000004';
const WYKOP_CLIP = 'https://wykop.pl/cdn/c3201142/clip.mp4';
const GIF_VIDEO = 'https://video.twimg.com/tweet_video/gif1.mp4';
const GIF_POSTER = 'https://pbs.twimg.com/tweet_video_thumb/gif1.jpg';
const VIDEO_POSTER = 'https://i.redd.it/poster-v.jpg';
const TAINTED_VIDEO = 'https://video.twimg.com/ext_tw_video/9/pu/vid/v.mp4';
const ROOT_URL = 'https://www.reddit.com/';
const WYKOP_PERMALINK = 'https://wykop.pl/wpis/77/tytul';

const ok = (fingerprint: Fingerprint, contentType: ContentType = 'image'): DecodeResult => ({ status: 'ok', contentType, fingerprint });

const MEDIA: Record<string, DecodeResult> = {
  [IMG.a]: ok(imageFp(HA)),
  [IMG.aCopy]: ok(imageFp(flip(HA, 1))),
  [IMG.b]: ok(imageFp(HB)),
  [IMG.c]: ok(imageFp(HC)),
  [IMG.d]: ok(imageFp(HD)),
  [IMG.e]: ok(imageFp(HE)),
};
const POSTERS: Record<string, DecodeResult> = {
  [GIF_POSTER]: ok(posterFp(HB), 'video'),
  [VIDEO_POSTER]: ok(posterFp(HC), 'video'),
};

type SeedRecord = {
  fingerprint: Fingerprint;
  contentType: ContentType;
  platform: Platform;
  postKey: string;
  permalink: string;
  firstSeenAt: number;
};
type Row = SeedRecord & { recordId: string; count: number; lastSeenAt: number };

const SEEN_A_ON_WYKOP: SeedRecord = {
  fingerprint: imageFp(HA),
  contentType: 'image',
  platform: 'wykop',
  postKey: 'wykop:entry:77',
  permalink: WYKOP_PERMALINK,
  firstSeenAt: NOW - DAY_MS,
};
const SEEN_POSTER_V: SeedRecord = {
  fingerprint: posterFp(HC),
  contentType: 'video',
  platform: 'reddit',
  postKey: 'reddit:t3_old',
  permalink: permalinkOf('old'),
  firstSeenAt: NOW - 3 * DAY_MS,
};

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function createFakeBackground(seed: SeedRecord[], now: () => number) {
  const requests: Request[] = [];
  const rows: Row[] = seed.map((r, i) => ({ ...r, recordId: `seed-${i}`, count: 1, lastSeenAt: r.firstSeenAt }));
  const gate = { hold: false, pending: [] as Array<{ url: string; release: () => void }>, started: [] as string[], peak: 0 };

  const bestMatch = (fp: Fingerprint): SeenMatch | null => {
    let best: SeenMatch | null = null;
    for (const row of rows) {
      const { matchClass } = compareFingerprints(fp, row.fingerprint, DEFAULT_THRESHOLDS);
      if (matchClass === 'different' || (best && (best.matchClass === 'exact' || matchClass === 'near'))) continue;
      best = {
        recordId: row.recordId,
        matchClass,
        platform: row.platform,
        firstSeenPostKey: row.postKey,
        firstSeenPermalink: row.permalink,
        firstSeenAt: row.firstSeenAt,
      };
    }
    return best;
  };

  const handle = async (req: Request): Promise<unknown> => {
    switch (req.type) {
      case 'media/fingerprint': {
        const url = req.req.url;
        gate.started.push(url);
        if (gate.hold) {
          gate.peak = Math.max(gate.peak, gate.pending.length + 1);
          await new Promise<void>((resolve) => gate.pending.push({ url, release: resolve }));
        }
        return encodeDecodeResult(MEDIA[url] ?? { status: 'skipped', reason: 'fetch-failed' });
      }
      case 'media/frames': {
        const frames = req.frames.map((f: WireGrayFrame) => decodeGrayFrame(f));
        if (frames.length === 0) {
          const poster = req.posterUrl ? POSTERS[req.posterUrl] : undefined;
          return encodeDecodeResult(poster ?? { status: 'skipped', reason: 'no-poster' });
        }
        return encodeDecodeResult(ok(fingerprintSequence(frames, req.durationS), 'video'));
      }
      case 'seen/lookup':
        return { matches: req.fingerprints.map((w) => bestMatch(decodeFingerprint(w))) };
      case 'seen/record': {
        const fp = decodeFingerprint(req.sighting.fingerprint);
        const match = bestMatch(fp);
        const row = match ? rows.find((r) => r.recordId === match.recordId) : undefined;
        if (row) {
          row.count++;
          row.lastSeenAt = now();
          return { recordId: row.recordId, isNew: false };
        }
        const { contentType, platform, postKey, permalink } = req.sighting;
        const recordId = `rec-${rows.length}`;
        rows.push({ fingerprint: fp, contentType, platform, postKey, permalink, firstSeenAt: now(), recordId, count: 1, lastSeenAt: now() });
        return { recordId, isNew: true };
      }
      case 'stats/hidden':
      case 'whitelist/add':
      case 'whitelist/remove':
      case 'log/warn':
        return { ok: true };
      default:
        throw new Error(`unexpected request ${req.type}`);
    }
  };

  const send = (async (req: Request) => {
    requests.push(json(req));
    return json(await handle(json(req)));
  }) as unknown as typeof sendRequest;

  const of = <K extends Request['type']>(type: K) => requests.filter((r): r is Extract<Request, { type: K }> => r.type === type);
  const fingerprintUrls = () => of('media/fingerprint').map((r) => r.req.url);
  const releaseNext = async () => {
    gate.pending.shift()?.release();
    await settle();
  };
  return { send, requests, rows, gate, of, fingerprintUrls, releaseNext };
}

const shadowRoots = new WeakMap<Element, ShadowRoot>();
const originalAttachShadow = Element.prototype.attachShadow;
let media: FakeMedia;
let running: Array<{ stop(): void }> = [];

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

beforeEach(() => {
  media = installFakeMedia();
  media.addVideo(CLIP_BLOB, videoFromAsset('clip.mp4'));
  media.addVideo(CLIP_BLOB_2, videoFromAsset('clip.mp4'));
  media.addVideo(WYKOP_CLIP, videoFromAsset('clip.mp4'));
  media.addVideo(GIF_VIDEO, { mode: 'tainted', durationS: 4 });
  media.addVideo(TAINTED_VIDEO, { mode: 'tainted', durationS: 12 });
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, init);
    shadowRoots.set(this, root);
    return root;
  };
  setUrl(ROOT_URL);
});

afterEach(() => {
  for (const runtime of running) runtime.stop();
  running = [];
  Element.prototype.attachShadow = originalAttachShadow;
  media.restore();
  for (const el of document.querySelectorAll('*')) if (shadowRoots.has(el)) el.remove();
  document.body.replaceChildren();
});

async function setup(opts: { posts: PostSpec[]; seen?: SeedRecord[]; platform?: Platform; url?: string; hold?: boolean }) {
  if (opts.url) setUrl(opts.url);
  const { createContentRuntime } = await loadRuntime();
  const clock = createFakeClock(NOW);
  const observers = createFakeObservers();
  const bg = createFakeBackground(opts.seen ?? [], clock.now);
  bg.gate.hold = opts.hold ?? false;
  const { feed, posts } = makeFeed(document, opts.posts);
  const runtime = createContentRuntime({
    adapter: createTestAdapter(opts.platform ?? 'reddit'),
    doc: document,
    win: window,
    send: bg.send,
    createObserver: observers.factory,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  running.push(runtime);
  const start = async () => {
    runtime.start();
    await settle();
  };
  const reveal = async (...els: Element[]) => {
    observers.enterLookahead(...els);
    await settle();
  };
  const dwell = async (el: Element) => {
    observers.setVisible(el, 1);
    await clock.advance(1000);
  };
  return { runtime, clock, observers, bg, feed, posts, start, reveal, dwell };
}

const isHidden = (post: Element) => post.hasAttribute('data-purefeed-hidden');
const img = (src: string | undefined, width = 600, height = 400) => ({ kind: 'img' as const, src, width, height });

function indicatorRoot(post: Element): ShadowRoot | null {
  const host = [post.previousElementSibling, post.nextElementSibling].find((el) => el?.hasAttribute('data-purefeed-ui'));
  return host ? (shadowRoots.get(host) ?? null) : null;
}

function textOf(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== 'STYLE') out += textOf(child);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function clickButton(post: Element, label: (text: string) => boolean): void {
  const root = indicatorRoot(post);
  const button = [...(root?.querySelectorAll('button') ?? [])].find((b) => label(textOf(b)));
  if (!button) throw new Error('indicator button not found');
  button.click();
}

const isShow = (text: string) => text === 'Show';
const isAlwaysPost = (text: string) => text === 'Always show this post';
const isAlwaysAuthor = (text: string) => text.startsWith('Always show ') && text !== 'Always show this post';

const toastTexts = () =>
  [...document.querySelectorAll('*')]
    .filter((el) => shadowRoots.has(el))
    .map((el) => textOf(shadowRoots.get(el) as ShadowRoot))
    .filter((text) => text.startsWith('PureFeed hid'));

const stripExtension = (html: string) => html.replace(/\s+data-purefeed-[\w-]+(="[^"]*")?/g, '');

async function playVideos(videos: HTMLVideoElement[], toS: number, stepS = 0.25) {
  const setPlayhead = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set;
  for (let t = 0; t <= toS + 1e-9; t += stepS) {
    for (const v of videos) setPlayhead?.call(v, Math.round(t * 1000) / 1000);
    await settle(2);
  }
  await settle();
}

function trapVideo(video: HTMLVideoElement) {
  const changes: string[] = [];
  for (const key of ['muted', 'volume', 'playbackRate', 'currentTime', 'src', 'crossOrigin', 'preload', 'loop']) {
    let d: PropertyDescriptor | undefined;
    for (let o: object | null = video; o && !d; o = Object.getPrototypeOf(o)) d = Object.getOwnPropertyDescriptor(o, key);
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => d?.get?.call(video),
      set: (value: unknown) => {
        changes.push(key);
        d?.set?.call(video, value);
      },
    });
  }
  for (const name of ['play', 'pause', 'load', 'fastSeek', 'setAttribute', 'removeAttribute']) {
    const original = (video as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    Object.defineProperty(video, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        changes.push(name);
        return original?.apply(video, args);
      },
    });
  }
  return changes;
}

describe('content runtime lookahead and job scheduling (AC-074, AC-076)', () => {
  it('should watch posts with a lookahead of 1.5 viewport heights below the viewport (TC-097)', async () => {
    const { start, observers } = await setup({ posts: [{ id: 'p1', media: [img(IMG.b)] }] });
    await start();
    expect(observers.lookaheadObservers().map((o) => o.init.rootMargin)).toContain('0px 0px 150% 0px');
  });

  it('should start no fingerprint job for a post before it is within the lookahead (TC-097)', async () => {
    const { start, reveal, bg, posts } = await setup({
      posts: [
        { id: 'p1', top: 0, media: [img(IMG.b)] },
        { id: 'p2', top: 3000, media: [img(IMG.c)] },
        { id: 'p3', top: 6000, media: [img(IMG.d)] },
      ],
    });
    await start();
    expect(bg.fingerprintUrls()).toEqual([]);
    await reveal(posts[1]);
    expect(bg.fingerprintUrls()).toEqual([IMG.c]);
  });

  it('should run at most 4 fingerprint jobs at once and start queued jobs nearest to the viewport first (TC-099)', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://i.redd.it/n${i}.png`);
    for (const [i, url] of urls.entries()) MEDIA[url] = ok(imageFp(randomHashes(1, 700 + i)[0]));
    const { start, reveal, bg, posts } = await setup({
      hold: true,
      posts: urls.map((url, i) => ({ id: `n${i}`, top: i * 120, media: [img(url)] })),
    });
    await start();
    await reveal(...posts.slice(0, 4));
    expect(bg.gate.started).toEqual(urls.slice(0, 4));
    await reveal(...posts.slice(4).reverse());
    expect(bg.gate.started).toHaveLength(4);
    while (bg.gate.pending.length > 0) await bg.releaseNext();
    expect(bg.gate.started).toEqual(urls);
    expect(bg.gate.peak).toBe(4);
  });

  it('should fingerprint only media rendered at >= 150 x 150 CSS px (TC-010)', async () => {
    const { start, reveal, bg, posts } = await setup({
      posts: [
        { id: 's1', media: [img(IMG.b, 149, 149)] },
        { id: 's2', media: [img(IMG.c, 150, 150)] },
        { id: 's3', media: [img(IMG.d, 150, 149)] },
      ],
    });
    await start();
    await reveal(...posts);
    expect(bg.fingerprintUrls()).toEqual([IMG.c]);
  });
});

describe('content runtime dynamic DOM (AC-045, AC-046, AC-047)', () => {
  it('should hide a duplicate among 20 posts appended after load without a reload (TC-062)', async () => {
    const { start, reveal, feed } = await setup({ posts: [{ id: 'p0', media: [img(IMG.b)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    const batch = Array.from({ length: 20 }, (_, i) =>
      makePost(document, { id: `q${i}`, top: 500 + i * 100, media: [img(i === 13 ? IMG.aCopy : `https://i.redd.it/q${i}.png`)] }),
    );
    feed.append(...batch);
    await settle();
    await reveal(...batch);
    expect(batch.filter(isHidden)).toEqual([batch[13]]);
  });

  it('should process 2 infinite scroll batches inserted in wrapper elements (TC-062)', async () => {
    const { start, reveal, feed, bg } = await setup({ posts: [], seen: [SEEN_A_ON_WYKOP] });
    await start();
    const batches: HTMLElement[][] = [];
    for (const b of [0, 1]) {
      const wrapper = document.createElement('div');
      const items = Array.from({ length: 5 }, (_, i) =>
        makePost(document, { id: `w${b}x${i}`, media: [img(i === 4 && b === 1 ? IMG.a : IMG.b)] }),
      );
      wrapper.append(...items);
      feed.append(wrapper);
      await settle();
      await reveal(...items);
      batches.push(items);
    }
    expect(isHidden(batches[1][4])).toBe(true);
    expect(bg.fingerprintUrls()).toContain(IMG.a);
  });

  it('should fingerprint an image whose src is set lazily after the post was inserted (TC-063)', async () => {
    const { start, reveal, bg, posts } = await setup({ posts: [{ id: 'lazy', media: [img(undefined)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(posts[0]);
    expect(bg.fingerprintUrls()).toEqual([]);
    mediaOf(posts[0]).setAttribute('src', IMG.a);
    await settle();
    expect(bg.fingerprintUrls()).toEqual([IMG.a]);
    expect(isHidden(posts[0])).toBe(true);
  });

  it('should run the fingerprint job once if mutations touch a processed post 50 times (TC-064)', async () => {
    const { start, reveal, bg, posts } = await setup({ posts: [{ id: 'm1', media: [img(IMG.b)] }] });
    await start();
    await reveal(posts[0]);
    for (let i = 0; i < 50; i++) {
      posts[0].className = `hover-${i}`;
      posts[0].append(document.createElement('span'));
      await settle(1);
    }
    await reveal(posts[0]);
    expect(bg.fingerprintUrls()).toEqual([IMG.b]);
  });

  it('should not process a post element again if the feed detaches and re-attaches it (AC-046)', async () => {
    const { start, reveal, bg, posts, feed } = await setup({ posts: [{ id: 'm2', media: [img(IMG.b)] }] });
    await start();
    await reveal(posts[0]);
    posts[0].remove();
    await settle();
    feed.append(posts[0]);
    await settle();
    await reveal(posts[0]);
    expect(bg.fingerprintUrls()).toEqual([IMG.b]);
  });

  it('should reveal and reprocess an element that a virtualized feed reuses for another post key (TC-065)', async () => {
    const { start, reveal, bg, posts } = await setup({ posts: [{ id: 'v1', media: [img(IMG.a)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(true);
    const el = posts[0];
    el.setAttribute('data-post', 'v2');
    mediaOf(el).setAttribute('src', IMG.e);
    await settle();
    await reveal(el);
    expect(isHidden(el)).toBe(false);
    expect(indicatorRoot(el)).toBeNull();
    expect(bg.fingerprintUrls()).toEqual([IMG.a, IMG.e]);
  });

  it('should hide a reused element again if its new post key carries seen media', async () => {
    const { start, reveal, posts } = await setup({ posts: [{ id: 'v3', media: [img(IMG.e)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(false);
    posts[0].setAttribute('data-post', 'v4');
    mediaOf(posts[0]).setAttribute('src', IMG.a);
    await settle();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(true);
  });

  it('should process the new view after an in-app navigation and keep the page session (TC-066)', async () => {
    const { start, reveal, dwell, bg, feed, posts } = await setup({ posts: [{ id: 'n1', media: [img(IMG.c)] }] });
    await start();
    await reveal(posts[0]);
    await dwell(mediaOf(posts[0]));
    expect(bg.of('seen/record')).toHaveLength(1);
    history.pushState({}, '', '/r/other/');
    feed.replaceChildren();
    const again = makePost(document, { id: 'n1', media: [img(IMG.c)] });
    const fresh = makePost(document, { id: 'n2', top: 600, media: [img(IMG.d)] });
    feed.append(again, fresh);
    await settle();
    await reveal(again, fresh);
    expect(bg.fingerprintUrls()).toContain(IMG.d);
    expect(isHidden(again)).toBe(false);
    expect(isHidden(fresh)).toBe(false);
  });

  it('should keep a post visible if the feed re-renders it after it was recorded in the same page session (TC-042)', async () => {
    const { start, reveal, dwell, feed, posts } = await setup({ posts: [{ id: 'r1', media: [img(IMG.c)] }] });
    await start();
    await reveal(posts[0]);
    await dwell(mediaOf(posts[0]));
    const rerender = makePost(document, { id: 'r1', media: [img(IMG.c)] });
    feed.replaceChild(rerender, posts[0]);
    await settle();
    await reveal(rerender);
    expect(isHidden(rerender)).toBe(false);
  });

  it('should hide the same post in a later page session (TC-043)', async () => {
    const first = await setup({ posts: [{ id: 'r2', media: [img(IMG.c)] }] });
    await first.start();
    await first.reveal(first.posts[0]);
    await first.dwell(mediaOf(first.posts[0]));
    const [recorded] = first.bg.rows;
    first.runtime.stop();
    document.body.replaceChildren();
    const second = await setup({ posts: [{ id: 'r2', media: [img(IMG.c)] }], seen: [recorded] });
    await second.start();
    await second.reveal(second.posts[0]);
    expect(isHidden(second.posts[0])).toBe(true);
  });

  it('should never hide the focal post on its permalink page and still record it (TC-044)', async () => {
    const { start, reveal, dwell, bg, posts } = await setup({
      url: permalinkOf('f1'),
      posts: [{ id: 'f1', media: [img(IMG.a)] }],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(false);
    await dwell(mediaOf(posts[0]));
    expect(bg.of('seen/record').map((r) => r.sighting.postKey)).toEqual(['reddit:t3_f1']);
    expect(bg.rows[0].count).toBe(2);
  });

  it('should keep the focal post visible after an in-app navigation to its permalink (TC-044)', async () => {
    const { start, reveal, feed } = await setup({ posts: [], seen: [SEEN_A_ON_WYKOP] });
    await start();
    history.pushState({}, '', '/r/test/comments/f2/post/');
    const focal = makePost(document, { id: 'f2', media: [img(IMG.a)] });
    feed.append(focal);
    await settle();
    await reveal(focal);
    expect(isHidden(focal)).toBe(false);
  });

  it('should not process posts inserted after stop', async () => {
    const { start, runtime, reveal, feed, bg } = await setup({ posts: [], seen: [SEEN_A_ON_WYKOP] });
    await start();
    runtime.stop();
    const late = makePost(document, { id: 'late', media: [img(IMG.a)] });
    feed.append(late);
    await settle();
    await reveal(late);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(isHidden(late)).toBe(false);
  });
});

describe('content runtime seen recording (AC-032)', () => {
  it('should record an item after >= 50% of it is visible for 1 continuous second (TC-045)', async () => {
    const { start, reveal, observers, clock, bg, posts } = await setup({ posts: [{ id: 'd1', author: 'alice', media: [img(IMG.c)] }] });
    await start();
    await reveal(posts[0]);
    observers.setVisible(mediaOf(posts[0]), 0.6);
    await clock.advance(999);
    expect(bg.of('seen/record')).toEqual([]);
    await clock.advance(1);
    const records = bg.of('seen/record');
    expect(records).toHaveLength(1);
    expect(records[0].sighting).toMatchObject({
      contentType: 'image',
      platform: 'reddit',
      postKey: 'reddit:t3_d1',
      permalink: permalinkOf('d1'),
    });
    expect(decodeFingerprint(records[0].sighting.fingerprint)).toEqual(imageFp(HC));
  });

  it('should not record an item visible for 0.9 s or only 40% visible for 5 s (TC-045)', async () => {
    const { start, reveal, observers, clock, bg, posts } = await setup({
      posts: [
        { id: 'd2', media: [img(IMG.c)] },
        { id: 'd3', top: 600, media: [img(IMG.d)] },
      ],
    });
    await start();
    await reveal(...posts);
    observers.setVisible(mediaOf(posts[0]), 0.6);
    await clock.advance(900);
    observers.setVisible(mediaOf(posts[0]), 0);
    observers.setVisible(mediaOf(posts[1]), 0.4);
    await clock.advance(5000);
    expect(bg.of('seen/record')).toEqual([]);
  });
});

describe('content runtime session duplicates (AC-033, AC-034, AC-050)', () => {
  it('should hide the later of 2 posts with the same unseen image without scrolling (TC-046)', async () => {
    const { start, reveal, posts } = await setup({
      posts: [
        { id: 'k1', top: 0, media: [img(IMG.b)] },
        { id: 'k2', top: 500, media: [img(IMG.c)] },
        { id: 'k3', top: 1000, media: [img(IMG.d)] },
        { id: 'k4', top: 1500, media: [img(IMG.e)] },
        { id: 'k5', top: 2000, media: [img(IMG.b)] },
      ],
    });
    await start();
    await reveal(...posts);
    expect(posts.map(isHidden)).toEqual([false, false, false, false, true]);
  });

  it('should keep a gallery visible if only one of its images is seen (TC-047)', async () => {
    const { start, reveal, posts } = await setup({ posts: [{ id: 'g1', media: [img(IMG.a), img(IMG.c)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(...posts);
    expect(isHidden(posts[0])).toBe(false);
  });

  it('should keep the hidden post and its descendants in the DOM and restore its markup on reveal (TC-069)', async () => {
    const { start, reveal, runtime, posts } = await setup({
      posts: [{ id: 'h1', author: 'alice', media: [img(IMG.a)] }],
      seen: [SEEN_A_ON_WYKOP],
    });
    const before = posts[0].outerHTML;
    const nodes = posts[0].querySelectorAll('*').length;
    await start();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(true);
    expect(posts[0].isConnected).toBe(true);
    expect(posts[0].querySelectorAll('*')).toHaveLength(nodes);
    runtime.revealAll();
    expect(isHidden(posts[0])).toBe(false);
    expect(stripExtension(posts[0].outerHTML)).toBe(before);
  });
});

describe('content runtime page videos (AC-014, AC-015, AC-020, AC-021, AC-022)', () => {
  it('should sample 8 frames of a playing blob video and send them as media/frames, never fetching the video (TC-019)', async () => {
    const { start, reveal, bg, posts } = await setup({
      posts: [{ id: 'vid1', media: [{ kind: 'video', src: CLIP_BLOB, width: 640, height: 360 }] }],
    });
    await start();
    await reveal(posts[0]);
    await playVideos([mediaOf(posts[0]) as HTMLVideoElement], 20);
    const frames = bg.of('media/frames');
    expect(frames).toHaveLength(1);
    expect(frames[0].frames).toHaveLength(8);
    expect(frames[0].durationS).toBe(20);
    const timestamps = frames[0].frames.map((f) => f.tS);
    expect(new Set(timestamps).size).toBe(8);
    expect([...timestamps].sort((x, y) => x - y)).toEqual(timestamps);
    expect(bg.fingerprintUrls()).toEqual([]);
  });

  it('should sample a readable same-origin http(s) page video too', async () => {
    setUrl('https://wykop.pl/');
    const { start, reveal, bg, posts } = await setup({
      platform: 'wykop',
      posts: [{ id: 'wv', media: [{ kind: 'video', src: WYKOP_CLIP, width: 640, height: 360 }] }],
    });
    await start();
    await reveal(posts[0]);
    await playVideos([mediaOf(posts[0]) as HTMLVideoElement], 20);
    expect(bg.of('media/frames').map((r) => r.frames.length)).toEqual([8]);
    expect(bg.fingerprintUrls()).toEqual([]);
  });

  it('should never change play state, position, mute state or volume of a page video (TC-026)', async () => {
    const { start, reveal, posts } = await setup({
      posts: [{ id: 'vid2', media: [{ kind: 'video', src: CLIP_BLOB, width: 640, height: 360 }] }],
    });
    const video = mediaOf(posts[0]) as HTMLVideoElement;
    video.muted = false;
    video.volume = 0.5;
    const changes = trapVideo(video);
    await start();
    await reveal(posts[0]);
    await playVideos([video], 20);
    expect(changes).toEqual([]);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.5);
  });

  it('should hide a later post whose page video shows the same clip as an earlier post', async () => {
    const { start, reveal, posts } = await setup({
      posts: [
        { id: 'c1', top: 0, media: [{ kind: 'video', src: CLIP_BLOB, width: 640, height: 360 }] },
        { id: 'c2', top: 600, media: [{ kind: 'video', src: CLIP_BLOB_2, width: 640, height: 360 }] },
      ],
    });
    await start();
    await reveal(...posts);
    await playVideos(
      posts.map((p) => mediaOf(p) as HTMLVideoElement),
      20,
    );
    expect(posts.map(isHidden)).toEqual([false, true]);
  });

  it('should not hide a video that shares only its opening with a seen video if the timeout cuts sampling short (AC-015)', async () => {
    const SHARED_INTRO_S = 5;
    const DURATION_S = 20;
    const SAMPLER_TIMEOUT_MS = 10_000;
    const [intro, endA, endB] = ['base.png', 'other-1.png', 'other-2.png'].map(loadGray);
    media.addVideo(INTRO_BLOB_A, { mode: 'ok', durationS: DURATION_S, frame: (tS) => (tS < SHARED_INTRO_S ? intro : endA) });
    media.addVideo(INTRO_BLOB_B, { mode: 'ok', durationS: DURATION_S, frame: (tS) => (tS < SHARED_INTRO_S ? intro : endB) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { start, reveal, bg, posts } = await setup({
        posts: [
          { id: 'ia', top: 0, media: [{ kind: 'video', src: INTRO_BLOB_A, width: 640, height: 360 }] },
          { id: 'ib', top: 600, media: [{ kind: 'video', src: INTRO_BLOB_B, width: 640, height: 360 }] },
        ],
      });
      await start();
      await reveal(...posts);
      await playVideos(
        posts.map((p) => mediaOf(p) as HTMLVideoElement),
        SHARED_INTRO_S,
      );
      vi.advanceTimersByTime(SAMPLER_TIMEOUT_MS);
      await settle();
      expect(bg.of('media/frames').map((r) => r.frames.length)).toEqual([0, 0]);
      expect(posts.map(isHidden)).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should send 0 frames with the poster URL if the page video is tainted, and keep the adapter type gif (TC-028, TC-018)', async () => {
    setUrl('https://x.com/home');
    const { start, reveal, dwell, bg, posts } = await setup({
      platform: 'x',
      posts: [{ id: 'gif1', media: [{ kind: 'video', src: GIF_VIDEO, poster: GIF_POSTER, type: 'gif', width: 640, height: 360 }] }],
    });
    await start();
    await reveal(posts[0]);
    await playVideos([mediaOf(posts[0]) as HTMLVideoElement], 4);
    const frames = bg.of('media/frames');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ frames: [], posterUrl: GIF_POSTER });
    expect(bg.fingerprintUrls()).not.toContain(GIF_VIDEO);
    await dwell(mediaOf(posts[0]));
    expect(bg.of('seen/record').map((r) => r.sighting.contentType)).toEqual(['gif']);
  });

  it('should hide a post by its poster-only fingerprint if the tainted video poster was seen (TC-028)', async () => {
    const { start, reveal, posts } = await setup({
      posts: [{ id: 'pv', media: [{ kind: 'video', src: TAINTED_VIDEO, poster: VIDEO_POSTER, width: 640, height: 360 }] }],
      seen: [SEEN_POSTER_V],
    });
    await start();
    await reveal(posts[0]);
    await playVideos([mediaOf(posts[0]) as HTMLVideoElement], 12, 0.5);
    expect(isHidden(posts[0])).toBe(true);
  });
});

describe('content runtime settings re-evaluation (AC-066)', () => {
  it('should reveal a post hidden only by a video if the video toggle goes off and keep an image post hidden (TC-086)', async () => {
    const { start, reveal, runtime, posts } = await setup({
      posts: [
        { id: 'tv', top: 0, media: [{ kind: 'video', src: TAINTED_VIDEO, poster: VIDEO_POSTER, width: 640, height: 360 }] },
        { id: 'ti', top: 600, media: [img(IMG.a)] },
      ],
      seen: [SEEN_POSTER_V, SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(...posts);
    await playVideos([mediaOf(posts[0]) as HTMLVideoElement], 12, 0.5);
    expect(posts.map(isHidden)).toEqual([true, true]);
    runtime.reevaluateAll({ ...DEFAULT_SETTINGS, contentTypes: { image: true, gif: true, video: false } });
    await settle();
    expect(posts.map(isHidden)).toEqual([false, true]);
  });

  it.each(['image', 'gif', 'video'] as const)('should send no fingerprint request for %s media if its toggle is turned off', async (type) => {
    const { start, reveal, runtime, bg, posts } = await setup({
      posts: [
        { id: 'ti', top: 0, media: [img(IMG.a)] },
        { id: 'tg', top: 600, media: [{ kind: 'video', src: GIF_VIDEO, poster: GIF_POSTER, type: 'gif', width: 640, height: 360 }] },
        { id: 'tv', top: 1200, media: [{ kind: 'video', src: TAINTED_VIDEO, poster: VIDEO_POSTER, width: 640, height: 360 }] },
      ],
    });
    await start();
    runtime.reevaluateAll({ ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes, [type]: false } });
    await reveal(...posts);
    await playVideos(
      posts.slice(1).map((p) => mediaOf(p) as HTMLVideoElement),
      12,
      0.5,
    );
    const posterType = (posterUrl: string | null) => (posterUrl === GIF_POSTER ? 'gif' : 'video');
    const requested = [...bg.fingerprintUrls().map(() => 'image'), ...bg.of('media/frames').map((r) => posterType(r.posterUrl))];
    expect(requested.sort()).toEqual(['gif', 'image', 'video'].filter((t) => t !== type));
  });

  it('should reveal every hidden post if deduplication is turned off', async () => {
    const { start, reveal, runtime, posts } = await setup({ posts: [{ id: 'off1', media: [img(IMG.a)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(...posts);
    expect(isHidden(posts[0])).toBe(true);
    runtime.reevaluateAll({ ...DEFAULT_SETTINGS, enabled: false });
    await settle();
    expect(isHidden(posts[0])).toBe(false);
    expect(indicatorRoot(posts[0])).toBeNull();
  });

  it('should reveal only the posts that the revealAll filter selects', async () => {
    const { start, reveal, runtime, posts } = await setup({
      posts: [
        { id: 'ra', author: 'alice', top: 0, media: [img(IMG.a)] },
        { id: 'rb', author: 'bob', top: 600, media: [img(IMG.aCopy)] },
      ],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(...posts);
    expect(posts.map(isHidden)).toEqual([true, true]);
    runtime.revealAll((p) => p.authorKey === 'reddit:u/bob');
    expect(posts.map(isHidden)).toEqual([true, false]);
  });
});

describe('content runtime hide indicator and toast (AC-029, AC-051, AC-053, AC-054, AC-055, AC-057, AC-058, AC-061)', () => {
  it('should show the indicator naming the platform of the first sighting (TC-041)', async () => {
    const { start, reveal, posts } = await setup({ posts: [{ id: 'i1', author: 'alice', media: [img(IMG.aCopy)] }], seen: [SEEN_A_ON_WYKOP] });
    await start();
    await reveal(posts[0]);
    const root = indicatorRoot(posts[0]);
    expect(root).not.toBeNull();
    expect(textOf(root as ShadowRoot)).toContain('Hidden by PureFeed: exact, seen on Wykop 1 d ago');
    expect(root?.querySelector('a')?.getAttribute('href')).toBe(WYKOP_PERMALINK);
  });

  it('should reveal the post on Show and keep it visible if the feed re-renders it (TC-072)', async () => {
    const { start, reveal, feed, bg, posts } = await setup({
      posts: [{ id: 'i2', author: 'alice', media: [img(IMG.a)] }],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    clickButton(posts[0], isShow);
    await settle();
    expect(isHidden(posts[0])).toBe(false);
    expect(indicatorRoot(posts[0])).toBeNull();
    const rerender = makePost(document, { id: 'i2', author: 'alice', media: [img(IMG.a)] });
    feed.replaceChild(rerender, posts[0]);
    await settle();
    await reveal(rerender);
    expect(isHidden(rerender)).toBe(false);
    expect(bg.of('whitelist/add')).toEqual([]);
  });

  it('should whitelist the post key on Always show this post, reveal it and still record its media (TC-073)', async () => {
    const { start, reveal, dwell, bg, posts } = await setup({
      posts: [{ id: 'i3', author: 'alice', media: [img(IMG.a)] }],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    clickButton(posts[0], isAlwaysPost);
    await settle();
    expect(bg.of('whitelist/add').map((r) => r.entry)).toEqual([{ type: 'post', key: 'reddit:t3_i3' }]);
    expect(isHidden(posts[0])).toBe(false);
    await dwell(mediaOf(posts[0]));
    expect(bg.rows[0].count).toBe(2);
  });

  it('should whitelist the author on Always show <author> and keep later posts of that author visible (TC-074)', async () => {
    const { start, reveal, feed, bg, posts } = await setup({
      posts: [{ id: 'i4', author: 'alice', media: [img(IMG.a)] }],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    clickButton(posts[0], isAlwaysAuthor);
    await settle();
    expect(bg.of('whitelist/add').map((r) => r.entry)).toEqual([{ type: 'source', key: 'reddit:u/alice' }]);
    expect(isHidden(posts[0])).toBe(false);
    const byAlice = makePost(document, { id: 'i5', author: 'alice', top: 600, media: [img(IMG.aCopy)] });
    const byBob = makePost(document, { id: 'i6', author: 'bob', top: 1200, media: [img(IMG.aCopy)] });
    feed.append(byAlice, byBob);
    await settle();
    await reveal(byAlice, byBob);
    expect([isHidden(byAlice), isHidden(byBob)]).toEqual([false, true]);
  });

  it('should count a hidden post once per post key per page session if the feed re-renders it 3 times (TC-081)', async () => {
    const { start, reveal, feed, bg, posts } = await setup({
      posts: [
        { id: 'c1', author: 'alice', top: 0, media: [img(IMG.a)] },
        { id: 'c2', author: 'bob', top: 600, media: [img(IMG.aCopy)] },
      ],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(...posts);
    let current = posts[0];
    for (let i = 0; i < 3; i++) {
      const rerender = makePost(document, { id: 'c1', author: 'alice', top: 0, media: [img(IMG.a)] });
      feed.replaceChild(rerender, current);
      current = rerender;
      await settle();
      await reveal(rerender);
      expect(isHidden(rerender)).toBe(true);
    }
    expect(bg.of('stats/hidden')).toHaveLength(2);
  });

  it('should show one toast for 3 posts hidden together (TC-077)', async () => {
    const { start, reveal, posts } = await setup({
      posts: [
        { id: 't1', top: 0, media: [img(IMG.a)] },
        { id: 't2', top: 600, media: [img(IMG.aCopy)] },
        { id: 't3', top: 1200, media: [img(IMG.a)] },
      ],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(...posts);
    expect(posts.map(isHidden)).toEqual([true, true, true]);
    expect(toastTexts()).toEqual(['PureFeed hid 3 duplicates']);
  });

  it('should add hides within 3 s to one toast and start a new count in the same toast after the window (AC-057)', async () => {
    const { start, reveal, clock, posts } = await setup({
      posts: [
        { id: 'w1', top: 0, media: [img(IMG.a)] },
        { id: 'w2', top: 600, media: [img(IMG.aCopy)] },
        { id: 'w3', top: 1200, media: [img(IMG.a)] },
      ],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    await clock.advance(2999);
    await reveal(posts[1]);
    expect(posts.map(isHidden)).toEqual([true, true, false]);
    expect(toastTexts()).toEqual(['PureFeed hid 2 duplicates']);
    await clock.advance(1);
    await reveal(posts[2]);
    expect(isHidden(posts[2])).toBe(true);
    expect(toastTexts()).toEqual(['PureFeed hid 1 duplicate']);
  });

  it('should close the toast exactly 4 s after the last hide (AC-057)', async () => {
    const { start, reveal, clock, posts } = await setup({
      posts: [
        { id: 'c1', top: 0, media: [img(IMG.a)] },
        { id: 'c2', top: 600, media: [img(IMG.aCopy)] },
      ],
      seen: [SEEN_A_ON_WYKOP],
    });
    await start();
    await reveal(posts[0]);
    await clock.advance(1000);
    await reveal(posts[1]);
    await clock.advance(3999);
    expect(toastTexts()).toEqual(['PureFeed hid 2 duplicates']);
    await clock.advance(1);
    expect(toastTexts()).toEqual([]);
    expect(posts.map(isHidden)).toEqual([true, true]);
  });

  it('should show no toast if the toast setting is off and still show the indicator (TC-078)', async () => {
    const { reveal, runtime, posts } = await setup({ posts: [{ id: 't4', media: [img(IMG.a)] }], seen: [SEEN_A_ON_WYKOP] });
    runtime.start();
    runtime.reevaluateAll({ ...DEFAULT_SETTINGS, toast: false } satisfies Settings);
    await settle();
    await reveal(posts[0]);
    expect(isHidden(posts[0])).toBe(true);
    expect(indicatorRoot(posts[0])).not.toBeNull();
    expect(toastTexts()).toEqual([]);
  });
});
