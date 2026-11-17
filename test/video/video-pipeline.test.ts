// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintImage } from '../../src/fingerprint/image-fingerprint.ts';
import type { SeenMatch } from '../../src/shared/types.ts';
import { decodeDecodeResult, type WireDecodeResult } from '../../src/shared/wire.ts';
import { orderedMatchPercent } from '../../src/similarity/sequence.ts';
import { loadGray } from '../helpers/assets.ts';
import { createFakeClock, settle } from '../helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../helpers/fake-media.ts';
import { createFakeObservers } from '../helpers/fake-observers.ts';
import { DEFAULT_THRESHOLDS } from '../helpers/fingerprints.ts';
import { createRealBackground } from '../helpers/real-background.ts';
import { createTestAdapter, type MediaSpec, makeFeed, mediaOf, type PostSpec } from '../helpers/test-adapter.ts';

const loadRuntime = () => import('../../src/content/runtime.ts');

const ASSET_TEST = { timeout: 60_000 };
const GIF_URL = 'https://i.redd.it/loop.gif';
const POSTER_URL = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.png';
const TAINTED_URLS = ['https://video.twimg.com/redirect-nocors/a.mp4', 'https://video.twimg.com/redirect-nocors/b.mp4'];
const NO_DURATION_URL = 'https://wykop.pl/stall/clip.mp4';
const NO_FRAME_URL = 'https://wykop.pl/stall/frames.mp4';
const FRAME_TIMEOUT_MS = 10_000;
const VIDEO_ASSETS = ['clip.mp4', 'clip-720.mp4', 'clip-360.webm', 'clip-intro.mp4', 'clip-outro.mp4', 'other.mp4', 'loop.mp4'];
const blobOf = (asset: string) => `blob:https://www.reddit.com/pf-${asset.replace('.', '-')}`;
const video = (asset: string): MediaSpec => ({ kind: 'video', src: blobOf(asset), width: 640, height: 360 });

let media: FakeMedia;
let running: Array<{ stop(): void }> = [];

beforeEach(() => {
  media = installFakeMedia();
  VIDEO_ASSETS.forEach((asset) => {
    media.addVideo(blobOf(asset), videoFromAsset(asset));
  });
  TAINTED_URLS.forEach((url) => {
    media.addVideo(url, { mode: 'tainted', durationS: 20 });
  });
  media.addVideo(NO_DURATION_URL, { mode: 'never-loads' });
  media.addVideo(NO_FRAME_URL, { mode: 'stalls-on-seek', durationS: 20 });
});

afterEach(() => {
  running.forEach((runtime) => {
    runtime.stop();
  });
  running = [];
  media.restore();
  document.body.replaceChildren();
});

async function playToEnd(el: HTMLVideoElement) {
  const setPlayhead = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set;
  const steps = Math.ceil(el.duration / 0.25);
  for (let i = 0; i <= steps; i++) {
    setPlayhead?.call(el, Math.min(el.duration, Math.round(i * 250) / 1000));
    await settle(2);
  }
  await settle();
}

async function pipeline() {
  const clock = createFakeClock();
  const bg = await createRealBackground({
    routes: { [GIF_URL]: { asset: 'loop.gif', mime: 'image/gif' }, [POSTER_URL]: { asset: 'base.png', mime: 'image/png' } },
    clock,
  });
  const { createContentRuntime } = await loadRuntime();
  const open = async (specs: PostSpec[]) => {
    document.body.replaceChildren();
    const observers = createFakeObservers();
    const { posts } = makeFeed(document, specs);
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
    running.push(runtime);
    runtime.start();
    await settle();
    observers.enterLookahead(...posts);
    await settle();
    return { runtime, observers, posts };
  };
  const outcome = async (id: string, spec: MediaSpec) => {
    const before = bg.exchanges.length;
    const { runtime, observers, posts } = await open([{ id, media: [spec] }]);
    const el = mediaOf(posts[0]);
    if (el instanceof HTMLVideoElement) await playToEnd(el);
    observers.setVisible(el, 1);
    await clock.advance(1000);
    runtime.stop();
    const exchanges = bg.exchanges.slice(before);
    const decoded = exchanges
      .filter((e) => e.req.type === 'media/frames' || e.req.type === 'media/fingerprint')
      .map((e) => decodeDecodeResult(e.res as WireDecodeResult));
    const lookups = exchanges.filter((e) => e.req.type === 'seen/lookup');
    const match = (lookups.at(-1)?.res as { matches: Array<SeenMatch | null> } | undefined)?.matches[0] ?? null;
    return { result: decoded.at(-1), match, isHidden: posts[0].hasAttribute('data-purefeed-hidden') };
  };
  const sequenceOf = async (id: string, spec: MediaSpec) => {
    const { result, match, isHidden } = await outcome(id, spec);
    if (result?.status !== 'ok' || result.fingerprint.kind !== 'sequence')
      throw new Error(`${id}: no frame sequence ${JSON.stringify(result)}`);
    return { fingerprint: result.fingerprint, contentType: result.contentType, match, isHidden };
  };
  const framesRequests = () => bg.exchanges.filter((e) => e.req.type === 'media/frames');
  return { bg, clock, open, outcome, sequenceOf, framesRequests };
}

describe('page video to stored frame sequence through runtime, background, decoder and hash worker (AC-015 to AC-019)', () => {
  it('should store a sequence of 8 frames at distinct timestamps, one in each eighth of a 20 s page video (TC-019)', ASSET_TEST, async () => {
    const { bg, sequenceOf } = await pipeline();
    const seen = await sequenceOf('v1', video('clip.mp4'));
    expect(bg.workerJobs).toEqual(['frames']);
    expect(seen.fingerprint.durationS).toBe(20);
    expect(seen.fingerprint.frames).toHaveLength(16);
    const timestamps = Array.from(seen.fingerprint.timestamps);
    expect(new Set(timestamps).size).toBe(8);
    timestamps.forEach((tS, i) => {
      expect(tS, `t${i}`).toBeGreaterThanOrEqual((i * 20) / 8);
      expect(tS, `t${i}`).toBeLessThan(((i + 1) * 20) / 8);
    });
    const frameHashes = Array.from({ length: 8 }, (_, i) => `${seen.fingerprint.frames[2 * i]}:${seen.fingerprint.frames[2 * i + 1]}`);
    expect(new Set(frameHashes).size).toBe(8);
    expect(bg.responsesOf('seen/record')).toEqual([{ recordId: 'rec-1', isNew: true }]);
  });

  it('should store all 3 distinct frames of an animated GIF image (TC-020)', ASSET_TEST, async () => {
    const { bg, sequenceOf } = await pipeline();
    const gif = await sequenceOf('g1', { kind: 'img', src: GIF_URL });
    expect(gif.contentType).toBe('gif');
    expect(gif.fingerprint.timestamps).toHaveLength(3);
    expect(bg.fetchCalls.map((c) => c.url)).toEqual([GIF_URL]);
  });

  it('should hide the MP4 conversion of a seen animated GIF at frame sequence similarity >= 90% (TC-021)', ASSET_TEST, async () => {
    const { sequenceOf } = await pipeline();
    const gif = await sequenceOf('g1', { kind: 'img', src: GIF_URL });
    const mp4 = await sequenceOf('g2', video('loop.mp4'));
    expect(orderedMatchPercent(gif.fingerprint, mp4.fingerprint, DEFAULT_THRESHOLDS.near)).toBeGreaterThanOrEqual(90);
    expect(orderedMatchPercent(mp4.fingerprint, gif.fingerprint, DEFAULT_THRESHOLDS.near)).toBeGreaterThanOrEqual(90);
    expect(mp4.match).not.toBeNull();
    expect(mp4.isHidden).toBe(true);
  });

  it('should hide the VP9 360p encoding of a seen H.264 720p clip as exact, and the reverse (TC-022)', ASSET_TEST, async () => {
    const forward = await pipeline();
    await forward.sequenceOf('a1', video('clip-720.mp4'));
    const webm = await forward.sequenceOf('a2', video('clip-360.webm'));
    expect([webm.match?.matchClass, webm.isHidden]).toEqual(['exact', true]);
    const reverse = await pipeline();
    await reverse.sequenceOf('b1', video('clip-360.webm'));
    const mp4 = await reverse.sequenceOf('b2', video('clip-720.mp4'));
    expect([mp4.match?.matchClass, mp4.isHidden]).toEqual(['exact', true]);
  });

  it('should hide the clip with a 5 s intro as near (TC-023)', ASSET_TEST, async () => {
    const { sequenceOf } = await pipeline();
    await sequenceOf('i1', video('clip.mp4'));
    const intro = await sequenceOf('i2', video('clip-intro.mp4'));
    expect([intro.match?.matchClass, intro.isHidden]).toEqual(['near', true]);
  });

  it('should hide the clip with a 4 s outro as near (TC-024)', ASSET_TEST, async () => {
    const { sequenceOf } = await pipeline();
    await sequenceOf('o1', video('clip.mp4'));
    const outro = await sequenceOf('o2', video('clip-outro.mp4'));
    expect([outro.match?.matchClass, outro.isHidden]).toEqual(['near', true]);
  });

  it('should keep an unrelated video visible and store it as a new record (TC-025)', ASSET_TEST, async () => {
    const { bg, sequenceOf } = await pipeline();
    await sequenceOf('u1', video('clip.mp4'));
    const other = await sequenceOf('u2', video('other.mp4'));
    expect([other.match, other.isHidden]).toEqual([null, false]);
    expect(bg.responsesOf('seen/record')).toEqual([
      { recordId: 'rec-1', isNew: true },
      { recordId: 'rec-2', isNew: true },
    ]);
  });
});

describe('unreadable page video frames through runtime, background, decoder and hash worker (AC-022)', () => {
  const posterVideo = (src: string): MediaSpec => ({ kind: 'video', src, poster: POSTER_URL, width: 640, height: 360 });
  const plainVideo = (src: string): MediaSpec => ({ kind: 'video', src, width: 640, height: 360 });

  it('should store the poster pixels as a poster-only fingerprint of a tainted page video and hide a later tainted video with that poster (TC-028)', async () => {
    const { bg, outcome, framesRequests } = await pipeline();
    const first = await outcome('t1', posterVideo(TAINTED_URLS[0]));
    expect(framesRequests().map((e) => e.req)).toEqual([{ type: 'media/frames', frames: [], durationS: 20, posterUrl: POSTER_URL }]);
    expect(first.result).toEqual({
      status: 'ok',
      contentType: 'video',
      fingerprint: { kind: 'poster', hash: fingerprintImage(loadGray('base.png'))?.hash },
    });
    expect(bg.fetchCalls.map((c) => c.url)).toEqual([POSTER_URL]);
    expect(bg.workerJobs).toEqual(['image']);
    const second = await outcome('t2', posterVideo(TAINTED_URLS[1]));
    expect([second.match?.matchClass, second.isHidden]).toEqual(['exact', true]);
  });

  it('should skip a page video without duration and poster exactly 10 s after it enters the lookahead and hide neither of 2 posts carrying it (TC-029)', async () => {
    const { bg, clock, open, framesRequests } = await pipeline();
    const { observers, posts } = await open([
      { id: 'n1', top: 0, media: [plainVideo(NO_DURATION_URL)] },
      { id: 'n2', top: 600, media: [plainVideo(NO_DURATION_URL)] },
    ]);
    await clock.advance(FRAME_TIMEOUT_MS - 1);
    expect(framesRequests()).toEqual([]);
    await clock.advance(1);
    expect(framesRequests().map((e) => [e.req, e.res])).toEqual(
      Array.from({ length: 2 }, () => [
        { type: 'media/frames', frames: [], durationS: 0, posterUrl: null },
        { status: 'skipped', reason: 'no-poster' },
      ]),
    );
    posts.forEach((post) => {
      observers.setVisible(mediaOf(post), 1);
    });
    await clock.advance(1000);
    expect(posts.map((post) => post.hasAttribute('data-purefeed-hidden'))).toEqual([false, false]);
    expect(bg.exchanges.filter((e) => e.req.type === 'seen/lookup' || e.req.type === 'seen/record')).toEqual([]);
    expect(bg.fetchCalls).toEqual([]);
  });

  it('should fall back to the poster exactly 10 s after sampling starts if the page video delivers no frame (AC-022)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { open, framesRequests } = await pipeline();
      await open([{ id: 'f1', media: [posterVideo(NO_FRAME_URL)] }]);
      vi.advanceTimersByTime(FRAME_TIMEOUT_MS - 1);
      await settle();
      expect(framesRequests()).toEqual([]);
      vi.advanceTimersByTime(1);
      await settle();
      expect(framesRequests().map((e) => [e.req, (e.res as WireDecodeResult).status])).toEqual([
        [{ type: 'media/frames', frames: [], durationS: 20, posterUrl: POSTER_URL }, 'ok'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
