import type { GrayImage } from '../shared/types.ts';
import { resizeArea } from './gray.ts';
import { packBits } from './phash.ts';

export const EDGE_GRID = 64;
const SOBEL_SIZE = 256;
const CELL = SOBEL_SIZE / EDGE_GRID;
const EDGE_THRESHOLD = 100;

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

export function edgeMap64(img: GrayImage): Uint32Array {
  const magnitudes = sobelMagnitudes(img);
  const cellPixels = Array.from({ length: CELL * CELL }, (_, k) => Math.floor(k / CELL) * SOBEL_SIZE + (k % CELL));
  return packBits(
    Array.from({ length: EDGE_GRID * EDGE_GRID }, (_, i) => {
      const origin = Math.floor(i / EDGE_GRID) * CELL * SOBEL_SIZE + (i % EDGE_GRID) * CELL;
      return cellPixels.reduce((sum, offset) => sum + magnitudes[origin + offset], 0) / cellPixels.length > EDGE_THRESHOLD;
    }),
  );
}
