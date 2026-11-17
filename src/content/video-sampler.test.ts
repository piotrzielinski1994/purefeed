// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settle } from '../../test/helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../../test/helpers/fake-media.ts';
import type { GrayFrame } from '../shared/types.ts';

const loadSampler = () => import('./video-sampler.ts');

const BLOB_URL = 'blob:https://www.reddit.com/7f6c1a2e-0000-4000-8000-000000000001';
const TAINTED_URL = 'https://video.twimg.com/tweet_video/abc.mp4';
const DURATION_S = 20;
const TARGETS = Array.from({ length: 8 }, (_, i) => ((i + 0.5) * DURATION_S) / 8);
const SIZE = 64;
const STATE_KEYS = [
  'muted',
  'volume',
  'playbackRate',
  'defaultMuted',
  'loop',
  'autoplay',
  'preload',
  'src',
  'crossOrigin',
  'currentSrc',
] as const;
const METHODS = ['play', 'pause', 'load', 'fastSeek', 'setAttribute', 'removeAttribute'] as const;

let media: FakeMedia;

beforeEach(() => {
  media = installFakeMedia();
  media.addVideo(BLOB_URL, videoFromAsset('clip.mp4'));
  media.addVideo(TAINTED_URL, { mode: 'tainted', durationS: 4 });
});

afterEach(() => {
  media.restore();
  document.body.replaceChildren();
});

function findDescriptor(target: object, key: string): PropertyDescriptor | undefined {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return d;
  }
  return undefined;
}

async function pageVideo(src: string) {
  const video = document.createElement('video');
  video.setAttribute('src', src);
  document.body.append(video);
  video.muted = false;
  video.volume = 0.5;
  await settle();
  const setPlayhead = findDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set as (this: HTMLMediaElement, v: number) => void;
  const playback: number[] = [];
  const writes: string[] = [];
  const calls: string[] = [];
  for (const key of [...STATE_KEYS, 'currentTime']) {
    const d = findDescriptor(video, key);
    let stored: unknown = d && 'value' in d ? d.value : undefined;
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => (d?.get ? d.get.call(video) : stored),
      set: (value: unknown) => {
        writes.push(key);
        if (d?.set) d.set.call(video, value);
        else stored = value;
      },
    });
  }
  for (const name of METHODS) {
    const original = (video as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    Object.defineProperty(video, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        calls.push(name);
        return original?.apply(video, args);
      },
    });
  }
  const play = async (fromS: number, toS: number, stepS = 0.25) => {
    for (let t = fromS; t <= toS + 1e-9; t += stepS) {
      const at = Math.round(t * 1000) / 1000;
      playback.push(at);
      setPlayhead.call(video, at);
      await settle(2);
    }
  };
  return { video, play, playback, writes, calls };
}

function collect() {
  const done: Array<GrayFrame[] | null> = [];
  return { done, onDone: (frames: GrayFrame[] | null) => void done.push(frames) };
}

describe('createVideoSampler (AC-015, AC-020, AC-022)', () => {
  it('should read one frame per target timestamp while the page video plays (TC-019)', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play } = await pageVideo(BLOB_URL);
    const { done, onDone } = collect();
    createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 10_000, onDone });
    await play(0, DURATION_S);
    expect(done).toHaveLength(1);
    const frames = done[0] ?? [];
    expect(frames.map((f) => f.tS)).toEqual(TARGETS);
    for (const frame of frames) {
      expect(Math.max(frame.image.width, frame.image.height)).toBe(SIZE);
      expect(frame.image.data).toHaveLength(frame.image.width * frame.image.height);
    }
  });

  it('should read distinct pixels at distinct timestamps', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play } = await pageVideo(BLOB_URL);
    const { done, onDone } = collect();
    createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 10_000, onDone });
    await play(0, DURATION_S);
    const frames = done[0] ?? [];
    const distinct = new Set(frames.map((f) => Buffer.from(f.image.data).toString('base64')));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('should never change play state, position, mute state or volume of the page video (TC-026)', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play, playback, writes, calls } = await pageVideo(BLOB_URL);
    await play(0, 3);
    const { onDone } = collect();
    createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 10_000, onDone });
    await play(3.25, DURATION_S);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(media.recordOf(video).seeks).toEqual(playback);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.5);
    expect(video.getAttribute('src')).toBe(BLOB_URL);
  });

  it('should answer null without touching the video if its pixels are tainted (TC-028)', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play, writes, calls } = await pageVideo(TAINTED_URL);
    const { done, onDone } = collect();
    createVideoSampler(video, { targets: [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75], size: SIZE, timeoutMs: 10_000, onDone });
    await play(0, 4);
    expect(done).toEqual([null]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('should answer null after the timeout if the video never plays and never call play (TC-029)', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, writes, calls } = await pageVideo(BLOB_URL);
    const { done, onDone } = collect();
    createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 30, onDone });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(done).toEqual([null]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('should answer the frames read so far if the timeout ends a partial playback', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play } = await pageVideo(BLOB_URL);
    const { done, onDone } = collect();
    createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 200, onDone });
    await play(0, 5);
    expect(done).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(done).toHaveLength(1);
    expect(done[0]?.map((f) => f.tS)).toEqual([1.25, 3.75]);
  });

  it('should stop sampling and never answer after it is disposed', async () => {
    const { createVideoSampler } = await loadSampler();
    const { video, play } = await pageVideo(BLOB_URL);
    const { done, onDone } = collect();
    const dispose = createVideoSampler(video, { targets: TARGETS, size: SIZE, timeoutMs: 50, onDone });
    await play(0, 2);
    dispose();
    await play(2.25, DURATION_S);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(done).toEqual([]);
  });
});
