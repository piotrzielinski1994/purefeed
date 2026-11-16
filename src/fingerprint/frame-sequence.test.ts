import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetPath, loadFrameSource } from '../../test/helpers/assets.ts';
import type { FrameSequenceFingerprint, FrameSource, GrayImage, Thresholds } from '../shared/types.ts';

const loadFrameSequence = () => import('./frame-sequence.ts');
const loadGif = () => import('./gif-decoder.ts');
const loadCompare = () => import('../similarity/compare.ts');
const loadSequence = () => import('../similarity/sequence.ts');
const ASSET_TEST = { timeout: 60_000 };
const DEFAULTS: Thresholds = { exact: 95, near: 90 };

async function videoFp(name: string): Promise<FrameSequenceFingerprint> {
  const { fingerprintFrameSource } = await loadFrameSequence();
  const fp = await fingerprintFrameSource(loadFrameSource(name));
  if (!fp) throw new Error(`${name}: no fingerprint`);
  return fp;
}

async function gifFp(name: string): Promise<FrameSequenceFingerprint> {
  const { decodeGif, fingerprintGif } = await loadGif();
  const fp = fingerprintGif(decodeGif(new Uint8Array(readFileSync(assetPath(name)))));
  if (fp?.kind !== 'sequence') throw new Error(`${name}: no frame sequence`);
  return fp;
}

async function classify(a: string, b: string): Promise<[string, string]> {
  const { compareFingerprints } = await loadCompare();
  const fa = await videoFp(a);
  const fb = await videoFp(b);
  return [compareFingerprints(fa, fb, DEFAULTS).matchClass, compareFingerprints(fb, fa, DEFAULTS).matchClass];
}

function textured(seed: number): GrayImage {
  const data = new Uint8Array(96 * 96);
  for (let i = 0; i < data.length; i++) data[i] = ((Math.floor(i / 96) >> 3) * 37 + ((i % 96) >> 3) * 91 + seed * 53) % 256;
  return { width: 96, height: 96, data };
}

function clockedSource(durationS: number, msPerFrame: number, clock: { t: number }, frame: (tS: number) => GrayImage | null): FrameSource {
  return {
    durationS,
    frameAt: async (tS) => {
      clock.t += msPerFrame;
      return frame(tS);
    },
    dispose: () => {},
  };
}

describe('frame timestamps (AC-015)', () => {
  it('should return 8 increasing timestamps, one in each eighth of the duration, if a duration is sampled', async () => {
    const { sampleTimestamps } = await loadFrameSequence();
    const ts = sampleTimestamps(20);
    expect(ts.length).toBe(8);
    ts.forEach((t, i) => {
      expect(t, `t${i}`).toBeGreaterThanOrEqual((i * 20) / 8);
      expect(t, `t${i}`).toBeLessThan(((i + 1) * 20) / 8);
    });
  });

  it('should return the given count of timestamps if count is passed', async () => {
    const { sampleTimestamps } = await loadFrameSequence();
    const ts = sampleTimestamps(10, 4);
    expect(ts.length).toBe(4);
    ts.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual((i * 10) / 4);
      expect(t).toBeLessThan(((i + 1) * 10) / 4);
    });
  });
});

describe('frame source fingerprint (AC-015)', () => {
  it('should give 8 frame fingerprints with 8 distinct timestamps if a 20 s video is fingerprinted', ASSET_TEST, async () => {
    const fp = await videoFp('clip.mp4');
    expect(fp.kind).toBe('sequence');
    expect(fp.frames).toBeInstanceOf(Uint32Array);
    expect(fp.frames.length).toBe(16);
    expect(fp.timestamps.length).toBe(8);
    expect(new Set(fp.timestamps).size).toBe(8);
    expect(fp.durationS).toBeCloseTo(20, 3);
    for (const t of fp.timestamps) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(20);
    }
  });

  it('should hash 8 different scenes if the 20 s clip holds 8 scenes of 2.5 s', ASSET_TEST, async () => {
    const fp = await videoFp('clip.mp4');
    const hashes = new Set<string>();
    for (let i = 0; i < 8; i++) hashes.add(`${fp.frames[2 * i]}:${fp.frames[2 * i + 1]}`);
    expect(hashes.size).toBe(8);
  });

  it('should return null if every frame arrives after the 10 s default deadline', async () => {
    const { fingerprintFrameSource } = await loadFrameSequence();
    const clock = { t: 0 };
    const src = clockedSource(20, 11_000, clock, (tS) => textured(Math.round(tS)));
    expect(await fingerprintFrameSource(src, { now: () => clock.t })).toBeNull();
  });

  it('should return 8 frames if every frame arrives within the deadline', async () => {
    const { fingerprintFrameSource } = await loadFrameSequence();
    const clock = { t: 0 };
    const src = clockedSource(20, 1_000, clock, (tS) => textured(Math.round(tS)));
    const fp = await fingerprintFrameSource(src, { now: () => clock.t });
    expect(fp?.timestamps.length).toBe(8);
  });

  it('should apply the given deadlineMs if it is shorter than 10 s', async () => {
    const { fingerprintFrameSource } = await loadFrameSequence();
    const clock = { t: 0 };
    const src = clockedSource(20, 1_000, clock, (tS) => textured(Math.round(tS)));
    expect(await fingerprintFrameSource(src, { deadlineMs: 500, now: () => clock.t })).toBeNull();
  });

  it('should return null if no frame can be read', async () => {
    const { fingerprintFrameSource } = await loadFrameSequence();
    const clock = { t: 0 };
    expect(
      await fingerprintFrameSource(
        clockedSource(20, 10, clock, () => null),
        { now: () => clock.t },
      ),
    ).toBeNull();
  });

  it('should resolve null if frameAt never settles before deadlineMs', { timeout: 5_000 }, async () => {
    const { fingerprintFrameSource } = await loadFrameSequence();
    const src: FrameSource = { durationS: 20, frameAt: () => new Promise<GrayImage | null>(() => {}), dispose: () => {} };
    expect(await fingerprintFrameSource(src, { deadlineMs: 50 })).toBeNull();
  });
});

describe('GIF and video frame matching (AC-016, AC-017, AC-018, AC-019)', () => {
  it('should reach frame sequence similarity >= 90% if loop.gif is compared with its MP4 and WebM conversions', ASSET_TEST, async () => {
    const { orderedMatchPercent } = await loadSequence();
    const gif = await gifFp('loop.gif');
    for (const name of ['loop.mp4', 'loop.webm']) {
      const video = await videoFp(name);
      expect(orderedMatchPercent(gif, video, DEFAULTS.near), name).toBeGreaterThanOrEqual(90);
      expect(orderedMatchPercent(video, gif, DEFAULTS.near), name).toBeGreaterThanOrEqual(90);
    }
  });

  it('should classify exact if the same video is encoded as H.264 720p and VP9 360p', ASSET_TEST, async () => {
    expect(await classify('clip-720.mp4', 'clip-360.webm')).toEqual(['exact', 'exact']);
  });

  it('should classify near if a 5 s intro is added to the 20 s clip', ASSET_TEST, async () => {
    expect(await classify('clip.mp4', 'clip-intro.mp4')).toEqual(['near', 'near']);
  });

  it('should classify near if a 4 s outro is added to the 20 s clip', ASSET_TEST, async () => {
    expect(await classify('clip.mp4', 'clip-outro.mp4')).toEqual(['near', 'near']);
  });

  it('should classify different if 2 unrelated videos are compared', ASSET_TEST, async () => {
    expect(await classify('clip.mp4', 'other.mp4')).toEqual(['different', 'different']);
  });
});
