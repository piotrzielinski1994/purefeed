// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SeenMatch } from '../../src/shared/types.ts';
import { decodeDecodeResult, type WireDecodeResult } from '../../src/shared/wire.ts';
import { orderedMatchPercent } from '../../src/similarity/sequence.ts';
import { createFakeClock, settle } from '../helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../helpers/fake-media.ts';
import { createFakeObservers } from '../helpers/fake-observers.ts';
import { DEFAULT_THRESHOLDS } from '../helpers/fingerprints.ts';
import { createRealBackground } from '../helpers/real-background.ts';
import { createTestAdapter, type MediaSpec, makeFeed, mediaOf } from '../helpers/test-adapter.ts';

const loadRuntime = () => import('../../src/content/runtime.ts');

const ASSET_TEST = { timeout: 60_000 };
const GIF_URL = 'https://i.redd.it/loop.gif';
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
  const bg = await createRealBackground({ routes: { [GIF_URL]: { asset: 'loop.gif', mime: 'image/gif' } }, clock });
  const { createContentRuntime } = await loadRuntime();
  const session = async (id: string, spec: MediaSpec) => {
    document.body.replaceChildren();
    const observers = createFakeObservers();
    const { posts } = makeFeed(document, [{ id, media: [spec] }]);
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
    observers.enterLookahead(posts[0]);
    await settle();
    const el = mediaOf(posts[0]);
    if (el instanceof HTMLVideoElement) await playToEnd(el);
    observers.setVisible(el, 1);
    await clock.advance(1000);
    const post = posts[0];
    runtime.stop();
    return post;
  };
  const sequenceOf = async (id: string, spec: MediaSpec) => {
    const before = bg.exchanges.length;
    const post = await session(id, spec);
    const decoded = bg.exchanges
      .slice(before)
      .filter((e) => e.req.type === 'media/frames' || e.req.type === 'media/fingerprint')
      .map((e) => decodeDecodeResult(e.res as WireDecodeResult));
    const lookups = bg.exchanges.slice(before).filter((e) => e.req.type === 'seen/lookup');
    const match = (lookups.at(-1)?.res as { matches: Array<SeenMatch | null> } | undefined)?.matches[0] ?? null;
    const result = decoded.at(-1);
    if (result?.status !== 'ok' || result.fingerprint.kind !== 'sequence')
      throw new Error(`${id}: no frame sequence ${JSON.stringify(result)}`);
    return { fingerprint: result.fingerprint, contentType: result.contentType, match, isHidden: post.hasAttribute('data-purefeed-hidden') };
  };
  return { bg, sequenceOf };
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
