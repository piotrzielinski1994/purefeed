import { CROP_VARIANTS } from '../fingerprint/crops.ts';
import type { CropRect } from '../fingerprint/gray.ts';
import type { ImageFingerprint } from '../shared/types.ts';
import { hamming64, similarityFromDistance } from './hamming.ts';

export type Alignment = { side: 'none' | 'a-cropped' | 'b-cropped'; crop: CropRect };

type Candidate = { distance: number; alignment: Alignment };

const NO_CROP: CropRect = { left: 0, right: 0, top: 0, bottom: 0 };

export function bestImageSimilarity(a: ImageFingerprint, b: ImageFingerprint): { similarity: number; alignment: Alignment } {
  const candidates: Candidate[] = [
    { distance: hamming64(a.hash, 0, b.hash, 0), alignment: { side: 'none', crop: NO_CROP } },
    ...CROP_VARIANTS.map((crop, i): Candidate => ({ distance: hamming64(a.crops, 2 * i, b.hash, 0), alignment: { side: 'a-cropped', crop } })),
    ...CROP_VARIANTS.map((crop, i): Candidate => ({ distance: hamming64(a.hash, 0, b.crops, 2 * i), alignment: { side: 'b-cropped', crop } })),
  ];
  const best = candidates.reduce((min, c) => (c.distance < min.distance ? c : min));
  return { similarity: similarityFromDistance(best.distance), alignment: best.alignment };
}
