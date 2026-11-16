import type { GrayImage, ImageFingerprint } from '../shared/types.ts';
import { cropHashes } from './crops.ts';
import { edgeMap64 } from './edges.ts';
import { resizeArea, stdDev } from './gray.ts';
import { pHash64 } from './phash.ts';

export const MIN_STD_DEV = 8;
const NORMALIZED_SIZE = 256;

export function fingerprintImage(img: GrayImage): ImageFingerprint | null {
  if (stdDev(img) < MIN_STD_DEV) {
    return null;
  }
  const normalized = resizeArea(img, NORMALIZED_SIZE, NORMALIZED_SIZE);
  return { kind: 'image', hash: pHash64(normalized), crops: cropHashes(normalized), edges: edgeMap64(normalized) };
}
