import type { FrameSequenceFingerprint } from '../shared/types.ts';
import { hamming64, similarityFromDistance } from './hamming.ts';

const WORDS_PER_FRAME = 2;
const DURATION_TOLERANCE = 0.05;

const frameCount = (fp: FrameSequenceFingerprint): number => fp.frames.length / WORDS_PER_FRAME;

const frameSimilarity = (a: FrameSequenceFingerprint, i: number, b: FrameSequenceFingerprint, j: number): number =>
  similarityFromDistance(hamming64(a.frames, WORDS_PER_FRAME * i, b.frames, WORDS_PER_FRAME * j));

export function orderedMatchPercent(a: FrameSequenceFingerprint, b: FrameSequenceFingerprint, near: number): number {
  const n = frameCount(a);
  const m = frameCount(b);
  const shorter = Math.min(n, m);
  if (shorter === 0) {
    return 0;
  }
  const lcs = Array.from({ length: n }).reduce<number[]>(
    (prev, _row, i) =>
      Array.from({ length: m }).reduce<number[]>(
        (row, _cell, j) => {
          const isMatch = frameSimilarity(a, i, b, j) >= near;
          row.push(isMatch ? prev[j] + 1 : Math.max(prev[j + 1], row[j]));
          return row;
        },
        [0],
      ),
    new Array<number>(m + 1).fill(0),
  );
  return (100 * lcs[m]) / shorter;
}

export function isExactSequence(a: FrameSequenceFingerprint, b: FrameSequenceFingerprint, exact: number): boolean {
  const n = frameCount(a);
  if (n !== frameCount(b) || Math.abs(a.durationS - b.durationS) > DURATION_TOLERANCE * Math.min(a.durationS, b.durationS)) {
    return false;
  }
  return Array.from({ length: n }).every((_v, i) => frameSimilarity(a, i, b, i) >= exact);
}
