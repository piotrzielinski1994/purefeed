import { describe, expect, it } from 'vitest';
import type { FrameSequenceFingerprint } from '../shared/types.ts';

const loadSequence = () => import('./sequence.ts');

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

function sequence(hashes: Hash[], durationS: number): FrameSequenceFingerprint {
  const frames = new Uint32Array(hashes.length * 2);
  const timestamps = new Float32Array(hashes.length);
  hashes.forEach(([lo, hi], i) => {
    frames[2 * i] = lo;
    frames[2 * i + 1] = hi;
    timestamps[i] = ((i + 0.5) * durationS) / hashes.length;
  });
  return { kind: 'sequence', frames, timestamps, durationS };
}

const A = randomHashes(10, 11);
const UNRELATED = randomHashes(12, 97);

describe('frame sequence similarity (AC-024)', () => {
  it('should return 100 if every frame of the shorter sequence matches in order', async () => {
    const { orderedMatchPercent } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    const b = sequence(
      A.slice(0, 8).map((h) => flip(h, 6)),
      20,
    );
    expect(orderedMatchPercent(a, b, 90)).toBe(100);
  });

  it('should count a frame pair at 90.6% as matched and at 89.1% as not matched if near threshold is 90', async () => {
    const { orderedMatchPercent } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    expect(
      orderedMatchPercent(
        a,
        sequence(
          A.slice(0, 8).map((h) => flip(h, 6)),
          20,
        ),
        90,
      ),
    ).toBe(100);
    expect(
      orderedMatchPercent(
        a,
        sequence(
          A.slice(0, 8).map((h) => flip(h, 7)),
          20,
        ),
        90,
      ),
    ).toBe(0);
  });

  it('should use the given near threshold if frames are matched', async () => {
    const { orderedMatchPercent } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    const b = sequence(
      A.slice(0, 8).map((h) => flip(h, 1)),
      20,
    );
    expect(orderedMatchPercent(a, b, 98)).toBe(100);
    expect(orderedMatchPercent(a, b, 99)).toBe(0);
  });

  it('should give 60% if 6 of the 10 frames of the shorter sequence match in order', async () => {
    const { orderedMatchPercent } = await loadSequence();
    const a = sequence(A, 20);
    const b = sequence(
      [A[0], UNRELATED[0], A[1], A[2], UNRELATED[1], A[3], A[4], UNRELATED[2], A[5], UNRELATED[3], UNRELATED[4], UNRELATED[5]],
      24,
    );
    expect(orderedMatchPercent(a, b, 90)).toBeCloseTo(60, 6);
    expect(orderedMatchPercent(b, a, 90)).toBeCloseTo(60, 6);
  });

  it('should count only the longest in-order run if matching frames appear out of order', async () => {
    const { orderedMatchPercent } = await loadSequence();
    const a = sequence(A, 20);
    const b = sequence([A[5], A[6], A[7], A[8], A[9], A[0], A[1], A[2], A[3], A[4], UNRELATED[0], UNRELATED[1]], 24);
    expect(orderedMatchPercent(a, b, 90)).toBeCloseTo(50, 6);
  });

  it('should give 0 if no frame matches', async () => {
    const { orderedMatchPercent } = await loadSequence();
    expect(orderedMatchPercent(sequence(A.slice(0, 8), 20), sequence(UNRELATED.slice(0, 8), 20), 90)).toBe(0);
  });

  it('should be exact if 8 aligned pairs are >= 95% and durations are 20.0 s and 21.0 s', async () => {
    const { isExactSequence } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    const b = sequence(
      A.slice(0, 8).map((h) => flip(h, 3)),
      21,
    );
    expect(isExactSequence(a, b, 95)).toBe(true);
    expect(isExactSequence(b, a, 95)).toBe(true);
  });

  it('should not be exact if durations are 20.0 s and 21.2 s', async () => {
    const { isExactSequence } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    const b = sequence(
      A.slice(0, 8).map((h) => flip(h, 3)),
      21.2,
    );
    expect(isExactSequence(a, b, 95)).toBe(false);
    expect(isExactSequence(b, a, 95)).toBe(false);
  });

  it('should not be exact if one aligned pair is below the exact threshold', async () => {
    const { isExactSequence } = await loadSequence();
    const a = sequence(A.slice(0, 8), 20);
    const hashes = A.slice(0, 8);
    hashes[4] = flip(hashes[4], 4);
    expect(isExactSequence(a, sequence(hashes, 20), 95)).toBe(false);
  });

  it('should not be exact if frame counts differ', async () => {
    const { isExactSequence } = await loadSequence();
    expect(isExactSequence(sequence(A.slice(0, 8), 20), sequence(A.slice(0, 7), 20), 95)).toBe(false);
  });
});
