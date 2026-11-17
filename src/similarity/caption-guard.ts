import { EDGE_GRID } from '../fingerprint/edges.ts';
import type { Alignment } from './image-similarity.ts';

type Grid = Uint8Array;
type Span = { a0: number; a1: number; b0: number; b1: number };
type Frame = { x: Span; y: Span };
type Steps = { x: readonly [number, number]; y: readonly [number, number] };

const BLOCK = 4;
const BLOCKS_PER_SIDE = EDGE_GRID / BLOCK;
const GUARD_BLOCK_CELLS = 2;
const GUARD_MIN_BLOCKS = 2;
const SHIFT_EVIDENCE_BLOCKS = 16;
const SHIFTED_BLOCK_CELLS = 3;
const FINE_STEPS_PER_SIDE = 128;
const COARSE_FACTOR = 4;
const MAX_CROP_FRACTION = 0.11;
const MAX_CROP_STEPS = Math.floor(MAX_CROP_FRACTION * FINE_STEPS_PER_SIDE);
const SEARCH_SAMPLES = 32;
const SEARCH_ROUNDS = 3;
const IMPROVEMENT = 1e-6;
const FULL: Span = { a0: 0, a1: 1, b0: 0, b1: 1 };
const IDENTITY: Frame = { x: FULL, y: FULL };
const OFFSETS = [-1, 0, 1];

const unpack = (map: Uint32Array): Grid => Uint8Array.from({ length: EDGE_GRID * EDGE_GRID }, (_, i) => (map[i >>> 5] >>> (i & 31)) & 1);

const cellAt = (grid: ArrayLike<number>, x: number, y: number): number =>
  x >= 0 && x < EDGE_GRID && y >= 0 && y < EDGE_GRID ? grid[y * EDGE_GRID + x] : 0;

const blur = (grid: Grid): Float32Array =>
  Float32Array.from(grid, (_, i) => {
    const x = i % EDGE_GRID;
    const y = Math.floor(i / EDGE_GRID);
    return OFFSETS.reduce((sum, dy) => OFFSETS.reduce((row, dx) => row + cellAt(grid, x + dx, y + dy), sum), 0);
  });

const spanOf = ([left, right]: readonly [number, number]): Span => {
  const l = left / FINE_STEPS_PER_SIDE;
  const r = right / FINE_STEPS_PER_SIDE;
  return { a0: Math.max(0, l), a1: 1 - Math.max(0, r), b0: Math.max(0, -l), b1: 1 - Math.max(0, -r) };
};

const frameOf = (steps: Steps): Frame => ({ x: spanOf(steps.x), y: spanOf(steps.y) });

const positions = (from: number, to: number, samples: number): Float32Array =>
  Float32Array.from({ length: samples }, (_, i) => (from + ((i + 0.5) / samples) * (to - from)) * EDGE_GRID - 0.5);

const clampCell = (p: number): number => Math.min(EDGE_GRID - 1, Math.max(0, p));

function lerpAt(values: Float32Array, offset: number, p: number): number {
  const c = clampCell(p);
  const i0 = Math.floor(c);
  const f = c - i0;
  return values[offset + i0] * (1 - f) + values[offset + Math.min(EDGE_GRID - 1, i0 + 1)] * f;
}

function crossLines(map: Float32Array, across: Float32Array, axis: keyof Steps): Float32Array {
  const at =
    axis === 'x'
      ? (line: number, t: number): number => map[line * EDGE_GRID + t]
      : (line: number, t: number): number => map[t * EDGE_GRID + line];
  return Float32Array.from({ length: across.length * EDGE_GRID }, (_, n) => {
    const c = clampCell(across[Math.floor(n / EDGE_GRID)]);
    const i0 = Math.floor(c);
    const f = c - i0;
    const t = n % EDGE_GRID;
    return at(i0, t) * (1 - f) + at(Math.min(EDGE_GRID - 1, i0 + 1), t) * f;
  });
}

function lineMisfit(linesA: Float32Array, linesB: Float32Array, span: Span): number {
  const pa = positions(span.a0, span.a1, SEARCH_SAMPLES);
  const pb = positions(span.b0, span.b1, SEARCH_SAMPLES);
  let total = 0;
  for (let k = 0; k < SEARCH_SAMPLES; k++) {
    for (let s = 0; s < SEARCH_SAMPLES; s++) {
      total += Math.abs(lerpAt(linesA, k * EDGE_GRID, pa[s]) - lerpAt(linesB, k * EDGE_GRID, pb[s]));
    }
  }
  return total;
}

const withinCropLimit = ([left, right]: readonly [number, number]): boolean => Math.abs(left) + Math.abs(right) <= MAX_CROP_STEPS;

const stepPairs = (center: readonly [number, number], radius: number, stride: number): Array<[number, number]> =>
  Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Array.from({ length: 2 * radius + 1 }, (_v, j): [number, number] => [center[0] + (i - radius) * stride, center[1] + (j - radius) * stride]),
  )
    .flat()
    .filter(withinCropLimit);

function refineAxis(fa: Float32Array, fb: Float32Array, steps: Steps, axis: keyof Steps): Steps {
  const other = frameOf(steps)[axis === 'x' ? 'y' : 'x'];
  const linesA = crossLines(fa, positions(other.a0, other.a1, SEARCH_SAMPLES), axis);
  const linesB = crossLines(fb, positions(other.b0, other.b1, SEARCH_SAMPLES), axis);
  const misfitOf = (pair: readonly [number, number]): number => lineMisfit(linesA, linesB, spanOf(pair));
  const pickBest = (start: readonly [number, number], pairs: Array<[number, number]>): readonly [number, number] =>
    pairs.reduce(
      (best, pair) => {
        const value = misfitOf(pair);
        return value < best.value - IMPROVEMENT ? { pair, value } : best;
      },
      { pair: start, value: misfitOf(start) },
    ).pair;
  const coarseRadius = Math.floor(MAX_CROP_STEPS / COARSE_FACTOR);
  const coarse = pickBest(steps[axis], stepPairs([0, 0], coarseRadius, COARSE_FACTOR));
  return { ...steps, [axis]: pickBest(coarse, stepPairs(coarse, COARSE_FACTOR - 1, 1)) };
}

function seedSteps(alignment: Alignment): Steps {
  const sign = alignment.side === 'b-cropped' ? -1 : 1;
  const steps = (from: number, to: number): [number, number] => [
    Math.round(sign * from * FINE_STEPS_PER_SIDE),
    Math.round(sign * to * FINE_STEPS_PER_SIDE),
  ];
  return { x: steps(alignment.crop.left, alignment.crop.right), y: steps(alignment.crop.top, alignment.crop.bottom) };
}

function estimateFrame(gridA: Grid, gridB: Grid, seed: Steps): Frame {
  const fa = blur(gridA);
  const fb = blur(gridB);
  const rounds = Array.from({ length: SEARCH_ROUNDS });
  return frameOf(rounds.reduce<Steps>((steps) => refineAxis(fa, fb, refineAxis(fa, fb, steps, 'x'), 'y'), seed));
}

function unmatchedPerBlock(gridA: Grid, gridB: Grid, frame: Frame, radius: number): Uint8Array {
  const xa = positions(frame.x.a0, frame.x.a1, EDGE_GRID);
  const xb = positions(frame.x.b0, frame.x.b1, EDGE_GRID);
  const ya = positions(frame.y.a0, frame.y.a1, EDGE_GRID);
  const yb = positions(frame.y.b0, frame.y.b1, EDGE_GRID);
  const near = Array.from({ length: 2 * radius + 1 }, (_, k) => k - radius);
  const isCovered = (grid: Grid, px: number, py: number): boolean => {
    const x = Math.round(clampCell(px));
    const y = Math.round(clampCell(py));
    return near.some((dy) => near.some((dx) => cellAt(grid, x + dx, y + dy) === 1));
  };
  const counts = new Uint8Array(BLOCKS_PER_SIDE * BLOCKS_PER_SIDE);
  for (let j = 0; j < EDGE_GRID; j++) {
    for (let i = 0; i < EDGE_GRID; i++) {
      const hasA = cellAt(gridA, Math.round(clampCell(xa[i])), Math.round(clampCell(ya[j]))) === 1;
      const hasB = cellAt(gridB, Math.round(clampCell(xb[i])), Math.round(clampCell(yb[j]))) === 1;
      if ((hasA && !hasB && !isCovered(gridB, xb[i], yb[j])) || (hasB && !hasA && !isCovered(gridA, xa[i], ya[j]))) {
        counts[Math.floor(j / BLOCK) * BLOCKS_PER_SIDE + Math.floor(i / BLOCK)]++;
      }
    }
  }
  return counts;
}

const blocksWith = (counts: Uint8Array, cells: number): number => counts.filter((n) => n >= cells).length;

export function guardRejects(a: Uint32Array, b: Uint32Array, alignment: Alignment): boolean {
  const gridA = unpack(a);
  const gridB = unpack(b);
  const direct = unmatchedPerBlock(gridA, gridB, IDENTITY, 0);
  if (blocksWith(direct, GUARD_BLOCK_CELLS) < GUARD_MIN_BLOCKS) {
    return false;
  }
  if (blocksWith(direct, 1) < SHIFT_EVIDENCE_BLOCKS) {
    return true;
  }
  return blocksWith(unmatchedPerBlock(gridA, gridB, estimateFrame(gridA, gridB, seedSteps(alignment)), 1), SHIFTED_BLOCK_CELLS) > 0;
}
