import { fingerprintImage } from '../../src/fingerprint/image-fingerprint.ts';
import type { GrayImage, ImageFingerprint, MatchClass } from '../../src/shared/types.ts';
import { compareFingerprints } from '../../src/similarity/compare.ts';
import { DEFAULT_THRESHOLDS } from './fingerprints.ts';

export type CropShape = { left: number; right: number; top: number; bottom: number };
export type CropResult = { shape: CropShape; classes: [MatchClass, MatchClass] };

const CROP_LIMIT = 0.1;
const X_STEPS = 10;
const Y_STEPS = 5;

const splits = (total: number, steps: number): Array<[number, number]> => {
  const step = (total * CROP_LIMIT) / steps;
  return Array.from({ length: steps + 1 }, (_, a) =>
    Array.from({ length: steps + 1 - a }, (_v, b): [number, number] => [a * step, b * step]),
  ).flat();
};

export const cropShapes = (img: GrayImage): CropShape[] =>
  splits(img.width, X_STEPS).flatMap(([left, right]) => splits(img.height, Y_STEPS).map(([top, bottom]) => ({ left, right, top, bottom })));

export function cropGray(img: GrayImage, shape: CropShape): GrayImage {
  const width = img.width - shape.left - shape.right;
  const height = img.height - shape.top - shape.bottom;
  const data = Uint8Array.from(
    { length: width * height },
    (_, i) => img.data[(shape.top + Math.floor(i / width)) * img.width + shape.left + (i % width)],
  );
  return { width, height, data };
}

function fingerprintOf(img: GrayImage): ImageFingerprint {
  const fp = fingerprintImage(img);
  if (!fp) throw new Error('no fingerprint');
  return fp;
}

export function sweepCrops(img: GrayImage, shapes: readonly CropShape[]): CropResult[] {
  const original = fingerprintOf(img);
  return shapes.map((shape) => {
    const cropped = fingerprintOf(cropGray(img, shape));
    return {
      shape,
      classes: [
        compareFingerprints(original, cropped, DEFAULT_THRESHOLDS).matchClass,
        compareFingerprints(cropped, original, DEFAULT_THRESHOLDS).matchClass,
      ],
    };
  });
}

export const isMatch = (r: CropResult): boolean => r.classes.every((c) => c !== 'different');
