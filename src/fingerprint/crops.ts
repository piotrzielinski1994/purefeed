import type { GrayImage } from '../shared/types.ts';
import { type CropRect, cropFraction } from './gray.ts';
import { pHash64 } from './phash.ts';

const AXIS_CROPS = [
  [0, 0],
  [0.1, 0],
  [0, 0.1],
  [0.05, 0.025],
  [0.025, 0.05],
] as const;

export const CROP_VARIANTS: readonly CropRect[] = AXIS_CROPS.flatMap(([left, right]) =>
  AXIS_CROPS.map(([top, bottom]) => ({ left, right, top, bottom })),
);

export const cropHashes = (img: GrayImage): Uint32Array =>
  Uint32Array.from(CROP_VARIANTS.flatMap((rect) => Array.from(pHash64(cropFraction(img, rect)))));
