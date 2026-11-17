// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetPath, loadGray } from '../../test/helpers/assets.ts';
import { createMediaFakes, type FakeMedia, type FakeRoute, installFakeMedia, videoFromAsset } from '../../test/helpers/fake-media.ts';
import { DEFAULT_THRESHOLDS } from '../../test/helpers/fingerprints.ts';
import { fingerprintFrameSource } from '../fingerprint/frame-sequence.ts';
import { decodeGif, fingerprintGif } from '../fingerprint/gif-decoder.ts';
import { resizeArea } from '../fingerprint/gray.ts';
import { fingerprintImage } from '../fingerprint/image-fingerprint.ts';
import type { DecodeResult, Fingerprint, GrayFrame } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';

const loadDecoder = () => import('./media-decoder.ts');

const IMAGE_URL = 'https://i.redd.it/abc123.png?width=640&format=pjpg&auto=webp&s=0a1b2c';
const GIF_URL = 'https://i.redd.it/loop.gif';
const STATIC_GIF_URL = 'https://i.redd.it/still.gif';
const VIDEO_URL = 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/clip.mp4?tag=12';
const POSTER_URL = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg';
const SEQUENCE_FRAME_SIZE = 64;

const ROUTES: Record<string, FakeRoute> = {
  [IMAGE_URL]: { asset: 'base.png', mime: 'image/png' },
  [GIF_URL]: { asset: 'loop.gif', mime: 'image/gif' },
  [STATIC_GIF_URL]: { asset: 'base-static.gif', mime: 'image/gif' },
  [POSTER_URL]: { asset: 'base-q60.jpg', mime: 'image/jpeg' },
  'https://pbs.twimg.com/media/missing.jpg': { status: 404 },
};

let media: FakeMedia;

beforeEach(() => {
  media = installFakeMedia();
});

afterEach(() => {
  media.restore();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function setup(routes: Record<string, FakeRoute> = ROUTES) {
  const { createMediaDecoder } = await loadDecoder();
  const fakes = createMediaFakes(routes);
  const decoder = createMediaDecoder({
    doc: document,
    fetch: fakes.fetch,
    worker: fakes.worker,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  return { decoder, ...fakes };
}

function expectOk(result: DecodeResult): Fingerprint {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.fingerprint;
}

const matchClass = (a: Fingerprint, b: Fingerprint) => compareFingerprints(a, b, DEFAULT_THRESHOLDS).matchClass;

async function expectedVideoFp(name: string) {
  const spec = videoFromAsset(name);
  if (spec.mode !== 'ok') throw new Error('asset spec');
  const fp = await fingerprintFrameSource({
    durationS: spec.durationS,
    frameAt: async (tS) => resizeArea(spec.frame(tS), SEQUENCE_FRAME_SIZE, SEQUENCE_FRAME_SIZE),
    dispose: () => {},
  });
  if (!fp) throw new Error(`${name}: no expected fingerprint`);
  return fp;
}

function pending<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

describe('media decoder (AC-008, AC-012, AC-014, AC-020, AC-021, AC-022, AC-070)', () => {
  it('should fetch exactly the currentSrc URL once without credentials and fingerprint the decoded pixels (TC-016 unit)', async () => {
    const { decoder, calls } = await setup();
    const result = await decoder.decode({ url: IMAGE_URL, contentType: 'image', posterUrl: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(IMAGE_URL);
    expect(calls[0].init).toMatchObject({ credentials: 'omit', cache: 'force-cache' });
    expect(calls[0].init?.body).toBeUndefined();
    const expected = fingerprintImage(loadGray('base.png'));
    if (!expected) throw new Error('base.png has no fingerprint');
    expect(result).toMatchObject({ status: 'ok', contentType: 'image' });
    expect(matchClass(expectOk(result), expected)).toBe('exact');
  });

  it('should skip with host-not-allowed and start no request if the URL is not on a media CDN host', async () => {
    const { decoder, calls } = await setup();
    const results = await Promise.all([
      decoder.decode({ url: 'https://media2.test/base.png', contentType: 'image', posterUrl: null }),
      decoder.decode({ url: 'http://i.redd.it/abc123.png', contentType: 'image', posterUrl: null }),
      decoder.decode({ url: 'https://evil.example/clip.mp4', contentType: 'video', posterUrl: null }),
    ]);
    expect(results).toEqual([
      { status: 'skipped', reason: 'host-not-allowed' },
      { status: 'skipped', reason: 'host-not-allowed' },
      { status: 'skipped', reason: 'host-not-allowed' },
    ]);
    expect(calls).toEqual([]);
    expect(media.videos).toEqual([]);
  });

  it('should skip with fetch-failed if the media request fails', async () => {
    const { decoder } = await setup();
    const result = await decoder.decode({ url: 'https://pbs.twimg.com/media/missing.jpg', contentType: 'image', posterUrl: null });
    expect(result).toEqual({ status: 'skipped', reason: 'fetch-failed' });
  });

  it('should give content type gif and a frame sequence if image bytes hold an animated GIF (TC-018 unit, TC-020)', async () => {
    const { decoder } = await setup();
    const result = await decoder.decode({ url: GIF_URL, contentType: 'image', posterUrl: null });
    const expected = fingerprintGif(decodeGif(new Uint8Array(readFileSync(assetPath('loop.gif')))));
    if (!expected) throw new Error('loop.gif has no fingerprint');
    expect(result).toMatchObject({ status: 'ok', contentType: 'gif', fingerprint: { kind: 'sequence' } });
    expect(matchClass(expectOk(result), expected)).toBe('exact');
    expect((expectOk(result) as Extract<Fingerprint, { kind: 'sequence' }>).timestamps).toHaveLength(3);
  });

  it('should keep content type image if a GIF has a single frame', async () => {
    const { decoder } = await setup();
    const result = await decoder.decode({ url: STATIC_GIF_URL, contentType: 'image', posterUrl: null });
    expect(result).toMatchObject({ status: 'ok', contentType: 'image', fingerprint: { kind: 'image' } });
  });

  it('should read 8 frames from its own muted video with ascending seeks, never fetch the video file, and release the video after the 8th frame (TC-019 unit)', async () => {
    const { decoder, calls } = await setup();
    media.addVideo(VIDEO_URL, videoFromAsset('clip.mp4'));
    const result = await decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: null });
    const fp = expectOk(result);
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'sequence', durationS: 20 } });
    expect(matchClass(fp, await expectedVideoFp('clip.mp4'))).toBe('exact');
    expect(calls.map((c) => c.url)).not.toContain(VIDEO_URL);
    expect(media.videos).toHaveLength(1);
    const [video] = media.videos;
    const seeks = video.seeks.filter((t) => t > 0);
    expect(new Set(seeks).size).toBe(8);
    expect(seeks).toEqual([...seeks].sort((a, b) => a - b));
    expect(seeks.every((t) => t < 20)).toBe(true);
    expect(video.disposed).toBe(true);
    expect(video.seeksAfterDispose).toBe(0);
    expect(video.element.getAttribute('src') ?? '').toBe('');
  });

  it('should give content type gif if the adapter marks a video as GIF (AC-014)', async () => {
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, videoFromAsset('loop.mp4'));
    const result = await decoder.decode({ url: VIDEO_URL, contentType: 'gif', posterUrl: null });
    expect(result).toMatchObject({ status: 'ok', contentType: 'gif', fingerprint: { kind: 'sequence' } });
  });

  it('should never change play state, position, mute state or volume of a page video with the same URL (AC-020)', async () => {
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, videoFromAsset('clip.mp4'));
    const page = document.createElement('video');
    page.src = VIDEO_URL;
    document.body.append(page);
    await Promise.resolve();
    page.currentTime = 3;
    page.muted = false;
    page.volume = 0.5;
    const record = media.recordOf(page);
    const before = { seeks: record.seeks.length, loads: record.loadCalls, currentTime: page.currentTime, paused: page.paused };
    await decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: null });
    expect({ seeks: record.seeks.length, loads: record.loadCalls, currentTime: page.currentTime, paused: page.paused }).toEqual(before);
    expect(page.muted).toBe(false);
    expect(page.volume).toBe(0.5);
    expect(page.getAttribute('src')).toBe(VIDEO_URL);
  });

  it('should give a poster-only fingerprint if the video canvas is tainted (TC-028 unit)', async () => {
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, { mode: 'tainted', durationS: 20 });
    const result = await decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: POSTER_URL });
    const expected = fingerprintImage(loadGray('base-q60.jpg'));
    if (!expected) throw new Error('poster has no fingerprint');
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'poster' } });
    expect(matchClass(expectOk(result), { kind: 'poster', hash: expected.hash })).toBe('exact');
  });

  it('should give a poster-only fingerprint if the video fails to decode', async () => {
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, { mode: 'error' });
    const result = await decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: POSTER_URL });
    expect(result).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'poster' } });
  });

  it('should skip with no-poster after 10 s and release the video if no frame arrives and there is no poster (TC-029 unit)', async () => {
    vi.useFakeTimers();
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, { mode: 'never-loads' });
    const state = pending(decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: null }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state).toEqual({ done: true, value: { status: 'skipped', reason: 'no-poster' } });
    expect(media.videos).toHaveLength(1);
    expect(media.videos[0].element.getAttribute('src') ?? '').toBe('');
  });

  it('should fall back to the poster after 10 s if the video loads metadata but no seek completes', async () => {
    vi.useFakeTimers();
    const { decoder } = await setup();
    media.addVideo(VIDEO_URL, { mode: 'stalls-on-seek', durationS: 20 });
    const state = pending(decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: POSTER_URL }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state.done).toBe(true);
    expect(state.value).toMatchObject({ status: 'ok', contentType: 'video', fingerprint: { kind: 'poster' } });
  });

  it('should not request a poster URL that is not on a media CDN host', async () => {
    const { decoder, calls } = await setup();
    media.addVideo(VIDEO_URL, { mode: 'tainted', durationS: 20 });
    const result = await decoder.decode({ url: VIDEO_URL, contentType: 'video', posterUrl: 'https://media2.test/poster.jpg' });
    expect(result.status).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('should hash frames sampled from a page video into a frame sequence (blob source)', async () => {
    const { decoder } = await setup();
    const spec = videoFromAsset('clip.mp4');
    if (spec.mode !== 'ok') throw new Error('asset spec');
    const expected = await expectedVideoFp('clip.mp4');
    const frames: GrayFrame[] = Array.from(expected.timestamps, (tS) => ({
      tS,
      image: resizeArea(spec.frame(tS), SEQUENCE_FRAME_SIZE, SEQUENCE_FRAME_SIZE),
    }));
    const result = await decoder.hashFrames(frames, spec.durationS, POSTER_URL);
    expect(result).toMatchObject({ status: 'ok', fingerprint: { kind: 'sequence' } });
    expect(matchClass(expectOk(result), expected)).toBe('exact');
  });

  it('should use the poster if no page video frame was sampled, and skip with no-poster without one', async () => {
    const { decoder } = await setup();
    expect(await decoder.hashFrames([], 20, POSTER_URL)).toMatchObject({ status: 'ok', fingerprint: { kind: 'poster' } });
    expect(await decoder.hashFrames([], 20, null)).toEqual({ status: 'skipped', reason: 'no-poster' });
  });
});
