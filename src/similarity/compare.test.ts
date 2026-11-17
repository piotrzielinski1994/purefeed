import { describe, expect, it } from 'vitest';
import { CROP_WORDS } from '../../test/helpers/fingerprints.ts';
import type { FrameSequenceFingerprint, ImageFingerprint, PosterFingerprint, Thresholds } from '../shared/types.ts';

const loadCompare = () => import('./compare.ts');

const DEFAULTS: Thresholds = { exact: 95, near: 90 };

type Hash = [number, number];

function randomHashes(n: number, seed: number): Hash[] {
  let x = seed >>> 0;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  return Array.from({ length: n }, () => [next(), next()]);
}

function flip(hash: Hash, bits: number): Hash {
  let [lo, hi] = hash;
  for (let i = 0; i < bits; i++) {
    if (i < 32) lo = (lo ^ (1 << i)) >>> 0;
    else hi = (hi ^ (1 << (i - 32))) >>> 0;
  }
  return [lo, hi];
}

const EDGES = Uint32Array.from(randomHashes(64, 5).flat());
const BASE: Hash = randomHashes(1, 23)[0];

function imageFp(hash: Hash): ImageFingerprint {
  const crops = Uint32Array.from({ length: CROP_WORDS }, (_, i) => ~hash[i % 2] >>> 0);
  return { kind: 'image', hash: Uint32Array.of(...hash), crops, edges: new Uint32Array(EDGES) };
}

function sequenceFp(hashes: Hash[], durationS: number): FrameSequenceFingerprint {
  const frames = Uint32Array.from(hashes.flat());
  const timestamps = Float32Array.from(hashes, (_h, i) => ((i + 0.5) * durationS) / hashes.length);
  return { kind: 'sequence', frames, timestamps, durationS };
}

function posterFp(hash: Hash): PosterFingerprint {
  return { kind: 'poster', hash: Uint32Array.of(...hash) };
}

const FRAMES = randomHashes(10, 11);
const UNRELATED = randomHashes(12, 97);

describe('match class (AC-023)', () => {
  it('should return exact at >= exact threshold, near at >= near threshold, else different', async () => {
    const { classifySimilarity } = await loadCompare();
    expect(classifySimilarity(100, DEFAULTS)).toBe('exact');
    expect(classifySimilarity(95, DEFAULTS)).toBe('exact');
    expect(classifySimilarity(94.99, DEFAULTS)).toBe('near');
    expect(classifySimilarity(90, DEFAULTS)).toBe('near');
    expect(classifySimilarity(89.99, DEFAULTS)).toBe('different');
    expect(classifySimilarity(0, DEFAULTS)).toBe('different');
  });

  it('should classify Hamming distance 3, 4, 6, 7 as exact, near, near, different if thresholds are default', async () => {
    const { compareFingerprints } = await loadCompare();
    const a = imageFp(BASE);
    const expected = { 3: 'exact', 4: 'near', 6: 'near', 7: 'different' } as const;
    const similarity = { 3: 95.3125, 4: 93.75, 6: 90.625, 7: 89.0625 } as const;
    for (const d of [3, 4, 6, 7] as const) {
      const result = compareFingerprints(a, imageFp(flip(BASE, d)), DEFAULTS);
      expect(result.matchClass, `distance ${d}`).toBe(expected[d]);
      if (result.matchClass !== 'different') expect(result.similarity, `distance ${d}`).toBeCloseTo(similarity[d], 6);
    }
  });

  it('should classify distance 0 as exact and distance 1 as near if exact threshold is 100%', async () => {
    const { compareFingerprints } = await loadCompare();
    const t = { exact: 100, near: 90 };
    const a = imageFp(BASE);
    expect(compareFingerprints(a, imageFp(BASE), t).matchClass).toBe('exact');
    expect(compareFingerprints(a, imageFp(flip(BASE, 1)), t).matchClass).toBe('near');
  });
});

describe('frame sequence match class (AC-024)', () => {
  it('should return exact if 8 aligned pairs are >= 95% and durations are 20.0 s and 21.0 s', async () => {
    const { compareFingerprints } = await loadCompare();
    const a = sequenceFp(FRAMES.slice(0, 8), 20);
    const b = sequenceFp(
      FRAMES.slice(0, 8).map((h) => flip(h, 2)),
      21,
    );
    expect(compareFingerprints(a, b, DEFAULTS).matchClass).toBe('exact');
  });

  it('should return near instead of exact if durations are 20.0 s and 21.2 s', async () => {
    const { compareFingerprints } = await loadCompare();
    const a = sequenceFp(FRAMES.slice(0, 8), 20);
    const b = sequenceFp(
      FRAMES.slice(0, 8).map((h) => flip(h, 2)),
      21.2,
    );
    expect(compareFingerprints(a, b, DEFAULTS).matchClass).toBe('near');
  });

  it('should return near if 6 of 10 frames of the shorter sequence match in order and different if 5 match', async () => {
    const { compareFingerprints } = await loadCompare();
    const a = sequenceFp(FRAMES, 20);
    const six = sequenceFp(
      [
        FRAMES[0],
        UNRELATED[0],
        FRAMES[1],
        FRAMES[2],
        UNRELATED[1],
        FRAMES[3],
        FRAMES[4],
        UNRELATED[2],
        FRAMES[5],
        UNRELATED[3],
        UNRELATED[4],
        UNRELATED[5],
      ],
      24,
    );
    const five = sequenceFp(
      [
        FRAMES[0],
        UNRELATED[0],
        FRAMES[1],
        FRAMES[2],
        UNRELATED[1],
        FRAMES[3],
        FRAMES[4],
        UNRELATED[2],
        UNRELATED[6],
        UNRELATED[3],
        UNRELATED[4],
        UNRELATED[5],
      ],
      24,
    );
    expect(compareFingerprints(a, six, DEFAULTS).matchClass).toBe('near');
    expect(compareFingerprints(six, a, DEFAULTS).matchClass).toBe('near');
    expect(compareFingerprints(a, five, DEFAULTS).matchClass).toBe('different');
  });

  it('should return different if 2 sequences share no frame', async () => {
    const { compareFingerprints } = await loadCompare();
    const result = compareFingerprints(sequenceFp(FRAMES.slice(0, 8), 20), sequenceFp(UNRELATED.slice(0, 8), 20), DEFAULTS);
    expect(result.matchClass).toBe('different');
  });
});

describe('fingerprint kinds (AC-025)', () => {
  it('should return different with similarity 0 if an image fingerprint equals frame 1 of a video', async () => {
    const { compareFingerprints } = await loadCompare();
    const video = sequenceFp(FRAMES.slice(0, 8), 20);
    const image = imageFp(FRAMES[0]);
    expect(compareFingerprints(image, video, DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
    expect(compareFingerprints(video, image, DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
  });

  it('should return different if a poster-only fingerprint is compared with the full frame sequence of the same video', async () => {
    const { compareFingerprints } = await loadCompare();
    const video = sequenceFp(FRAMES.slice(0, 8), 20);
    const poster = posterFp(FRAMES[0]);
    expect(compareFingerprints(poster, video, DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
    expect(compareFingerprints(video, poster, DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
  });

  it('should return different if a poster-only fingerprint is compared with an equal image fingerprint', async () => {
    const { compareFingerprints } = await loadCompare();
    expect(compareFingerprints(posterFp(BASE), imageFp(BASE), DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
    expect(compareFingerprints(imageFp(BASE), posterFp(BASE), DEFAULTS)).toEqual({ matchClass: 'different', similarity: 0 });
  });

  it('should return exact if 2 poster-only fingerprints are identical or at exact similarity', async () => {
    const { compareFingerprints } = await loadCompare();
    expect(compareFingerprints(posterFp(BASE), posterFp(BASE), DEFAULTS).matchClass).toBe('exact');
    expect(compareFingerprints(posterFp(BASE), posterFp(flip(BASE, 3)), DEFAULTS).matchClass).toBe('exact');
  });

  it('should return different if 2 poster-only fingerprints are only at near similarity', async () => {
    const { compareFingerprints } = await loadCompare();
    for (const d of [4, 6])
      expect(compareFingerprints(posterFp(BASE), posterFp(flip(BASE, d)), DEFAULTS).matchClass, `distance ${d}`).toBe('different');
  });
});
