import { EDGE_GRID } from '../fingerprint/edges.ts';
import type { CropRect } from '../fingerprint/gray.ts';
import type { Alignment } from './image-similarity.ts';

type EdgeGrid = readonly boolean[];

const BLOCK = 4;
const BLOCKS_PER_SIDE = EDGE_GRID / BLOCK;
const GUARD_BLOCK_RATIO = 0.15;
const GUARD_MIN_BLOCKS = 2;
const FULL_FRAME: CropRect = { left: 0, right: 0, top: 0, bottom: 0 };

const bitAt = (map: Uint32Array, i: number): boolean => ((map[i >>> 5] >>> (i & 31)) & 1) === 1;

function sampleGrid(map: Uint32Array, crop: CropRect): EdgeGrid {
  const x0 = crop.left * EDGE_GRID;
  const y0 = crop.top * EDGE_GRID;
  const xScale = 1 - crop.left - crop.right;
  const yScale = 1 - crop.top - crop.bottom;
  return Array.from({ length: EDGE_GRID * EDGE_GRID }, (_, i) => {
    const x = Math.floor(x0 + ((i % EDGE_GRID) + 0.5) * xScale);
    const y = Math.floor(y0 + (Math.floor(i / EDGE_GRID) + 0.5) * yScale);
    return bitAt(map, y * EDGE_GRID + x);
  });
}

const dilate = (grid: EdgeGrid): EdgeGrid =>
  grid.map((_, i) => {
    const x = i % EDGE_GRID;
    const y = Math.floor(i / EDGE_GRID);
    return [-1, 0, 1].some((dy) =>
      [-1, 0, 1].some((dx) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && nx < EDGE_GRID && ny >= 0 && ny < EDGE_GRID && grid[ny * EDGE_GRID + nx];
      }),
    );
  });

export function guardRejects(a: Uint32Array, b: Uint32Array, alignment: Alignment): boolean {
  const gridA = sampleGrid(a, alignment.side === 'a-cropped' ? alignment.crop : FULL_FRAME);
  const gridB = sampleGrid(b, alignment.side === 'b-cropped' ? alignment.crop : FULL_FRAME);
  const isShifted = alignment.side !== 'none';
  const coverA = isShifted ? dilate(gridA) : gridA;
  const coverB = isShifted ? dilate(gridB) : gridB;
  const isUnmatched = (i: number): boolean => (gridA[i] && !coverB[i]) || (gridB[i] && !coverA[i]);
  const blockSize = BLOCK * BLOCK;
  const mismatchedBlocks = Array.from({ length: BLOCKS_PER_SIDE * BLOCKS_PER_SIDE }).filter((_v, k) => {
    const bx = k % BLOCKS_PER_SIDE;
    const by = Math.floor(k / BLOCKS_PER_SIDE);
    const unmatched = Array.from({ length: blockSize }).filter((_c, c) =>
      isUnmatched((by * BLOCK + Math.floor(c / BLOCK)) * EDGE_GRID + bx * BLOCK + (c % BLOCK)),
    ).length;
    return unmatched / blockSize > GUARD_BLOCK_RATIO;
  });
  return mismatchedBlocks.length >= GUARD_MIN_BLOCKS;
}
