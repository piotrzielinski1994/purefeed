import { CROP_VARIANTS } from '../../src/fingerprint/crops.ts';
import type {
  ContentType,
  FrameSequenceFingerprint,
  ImageFingerprint,
  Platform,
  PosterFingerprint,
  Sighting,
  Thresholds,
} from '../../src/shared/types.ts';

export type Hash = [number, number];

export const DEFAULT_THRESHOLDS: Thresholds = { exact: 95, near: 90 };
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export function randomHashes(n: number, seed: number): Hash[] {
  let x = seed >>> 0;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  return Array.from({ length: n }, () => [next(), next()]);
}

export function flip(hash: Hash, bits: number): Hash {
  let [lo, hi] = hash;
  for (let i = 0; i < bits; i++) {
    if (i < 32) lo = (lo ^ (1 << i)) >>> 0;
    else hi = (hi ^ (1 << (i - 32))) >>> 0;
  }
  return [lo, hi];
}

const EDGES = Uint32Array.from(randomHashes(64, 5).flat());

export const CROP_WORDS = 2 * CROP_VARIANTS.length;

export function imageFp(hash: Hash): ImageFingerprint {
  const crops = Uint32Array.from({ length: CROP_WORDS }, (_, i) => ~hash[i % 2] >>> 0);
  return { kind: 'image', hash: Uint32Array.of(...hash), crops, edges: new Uint32Array(EDGES) };
}

export function imageFpWithCropDeltas(hash: Hash, cropDeltas: Uint32Array): ImageFingerprint {
  const crops = cropDeltas.map((delta, i) => (delta ^ hash[i % 2]) >>> 0);
  return { kind: 'image', hash: Uint32Array.of(...hash), crops, edges: new Uint32Array(EDGES) };
}

export function sequenceFp(hashes: Hash[], durationS: number): FrameSequenceFingerprint {
  const frames = Uint32Array.from(hashes.flat());
  const timestamps = Float32Array.from(hashes, (_h, i) => ((i + 0.5) * durationS) / hashes.length);
  return { kind: 'sequence', frames, timestamps, durationS };
}

export function posterFp(hash: Hash): PosterFingerprint {
  return { kind: 'poster', hash: Uint32Array.of(...hash) };
}

export function sightingOf(
  fingerprint: Sighting['fingerprint'],
  overrides: Partial<{ contentType: ContentType; platform: Platform; postKey: string; permalink: string }> = {},
): Sighting {
  const contentType = overrides.contentType ?? (fingerprint.kind === 'image' ? 'image' : 'video');
  return {
    fingerprint,
    contentType,
    platform: overrides.platform ?? 'reddit',
    postKey: overrides.postKey ?? 'reddit:t3_abc',
    permalink: overrides.permalink ?? 'https://www.reddit.com/r/memes/comments/abc/x/',
  };
}
