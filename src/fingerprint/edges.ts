import type { GrayImage } from '../shared/types.ts';
import { resizeArea } from './gray.ts';
import { packBits } from './phash.ts';

export const EDGE_GRID = 64;
const SOBEL_SIZE = 256;
const CELL = SOBEL_SIZE / EDGE_GRID;
const WINDOW = 6;
const WINDOW_OFFSET = 1;
const EDGE_THRESHOLD = 75;

function sobelMagnitudes(img: GrayImage): Float64Array {
  const { data } = resizeArea(img, SOBEL_SIZE, SOBEL_SIZE);
  const last = SOBEL_SIZE - 1;
  const at = (x: number, y: number): number => data[Math.min(last, Math.max(0, y)) * SOBEL_SIZE + Math.min(last, Math.max(0, x))];
  return Float64Array.from({ length: SOBEL_SIZE * SOBEL_SIZE }, (_, i) => {
    const x = i % SOBEL_SIZE;
    const y = Math.floor(i / SOBEL_SIZE);
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    return Math.hypot(gx, gy);
  });
}

const WINDOW_SPANS = Array.from({ length: EDGE_GRID }, (_, cell) =>
  Array.from({ length: WINDOW }, (_v, k) => cell * CELL - WINDOW_OFFSET + k).filter((p) => p >= 0 && p < SOBEL_SIZE),
);

export function edgeMap64(img: GrayImage): Uint32Array {
  const magnitudes = sobelMagnitudes(img);
  return packBits(
    Array.from({ length: EDGE_GRID * EDGE_GRID }, (_, i) => {
      const xs = WINDOW_SPANS[i % EDGE_GRID];
      const ys = WINDOW_SPANS[Math.floor(i / EDGE_GRID)];
      const sum = ys.reduce((total, y) => xs.reduce((row, x) => row + magnitudes[y * SOBEL_SIZE + x], total), 0);
      return sum / (xs.length * ys.length) > EDGE_THRESHOLD;
    }),
  );
}
