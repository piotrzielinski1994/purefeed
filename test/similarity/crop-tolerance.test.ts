import { describe, expect, it } from 'vitest';
import type { GrayImage } from '../../src/shared/types.ts';
import { loadGray } from '../helpers/assets.ts';
import { type CropShape, cropGray, cropShapes, isMatch, sweepCrops } from '../helpers/crop-sweep.ts';
import { DEFAULT_THRESHOLDS } from '../helpers/fingerprints.ts';

const ASSET_TEST = { timeout: 240_000 };
const SAMPLE_STRIDE = 14;
const BLOCK_WHITE = 250;
const LOGO = { width: 134, height: 134 };
const TEXT_BLOCK = { width: 100, height: 60 };
const OVERLAY_CROPS: CropShape[] = [
  { left: 30, right: 0, top: 0, bottom: 0 },
  { left: 0, right: 0, top: 30, bottom: 30 },
  { left: 18, right: 18, top: 12, bottom: 24 },
  { left: 24, right: 24, top: 24, bottom: 24 },
];

type Block = { x: number; y: number; width: number; height: number };

const textPattern = (x: number, y: number): number => (((x >> 2) + (y >> 2)) % 2 === 1 ? 255 : 0);

function withBlock(image: GrayImage, block: Block, paint: (x: number, y: number) => number): GrayImage {
  const isInside = (x: number, y: number): boolean => x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height;
  const data = image.data.map((value, i) =>
    isInside(i % image.width, Math.floor(i / image.width)) ? paint(i % image.width, Math.floor(i / image.width)) : value,
  );
  return { ...image, data };
}

async function classesOf(a: GrayImage, b: GrayImage): Promise<string[]> {
  const { compareFingerprints } = await import('../../src/similarity/compare.ts');
  const { fingerprintImage } = await import('../../src/fingerprint/image-fingerprint.ts');
  const [fa, fb] = [fingerprintImage(a), fingerprintImage(b)];
  if (!fa || !fb) throw new Error('no fingerprint');
  return [compareFingerprints(fa, fb, DEFAULT_THRESHOLDS).matchClass, compareFingerprints(fb, fa, DEFAULT_THRESHOLDS).matchClass];
}

describe('crops of any shape within the AC-011 limit (AC-011)', () => {
  it('should match base.png cropped by up to 10% of width and height in every shape of a stratified sample of crop shapes', ASSET_TEST, () => {
    const base = loadGray('base.png');
    const sample = cropShapes(base).filter((_shape, i) => i % SAMPLE_STRIDE === 0);
    const results = sweepCrops(base, sample);
    const missed = results.filter((r) => !isMatch(r)).map((r) => `${JSON.stringify(r.shape)} ${r.classes.join('/')}`);
    expect(sample.length).toBeGreaterThanOrEqual(99);
    expect(missed).toEqual([]);
  });

  it('should return different if a copy with an added logo, block or text is also cropped', ASSET_TEST, async () => {
    const base = loadGray('base.png');
    const caption = loadGray('caption-a.png');
    const white = () => BLOCK_WHITE;
    const overlays: Record<string, [GrayImage, GrayImage]> = {
      'logo5.png': [base, loadGray('logo5.png')],
      'caption-b.png': [caption, loadGray('caption-b.png')],
      'screenshot-2.png': [loadGray('screenshot-1.png'), loadGray('screenshot-2.png')],
      'text top-left': [caption, withBlock(caption, { x: 20, y: 20, ...TEXT_BLOCK }, textPattern)],
      'text top-right': [caption, withBlock(caption, { x: 480, y: 20, ...TEXT_BLOCK }, textPattern)],
      'text bottom-right': [caption, withBlock(caption, { x: 480, y: 520, ...TEXT_BLOCK }, textPattern)],
      'block top-left': [base, withBlock(base, { x: 10, y: 10, ...LOGO }, white)],
      'block top-right': [base, withBlock(base, { x: 456, y: 10, ...LOGO }, white)],
      'block bottom-left': [base, withBlock(base, { x: 10, y: 456, ...LOGO }, white)],
      'block centre': [base, withBlock(base, { x: 233, y: 233, ...LOGO }, white)],
      'block right middle': [base, withBlock(base, { x: 456, y: 233, ...LOGO }, white)],
      'band 400x45': [base, withBlock(base, { x: 100, y: 540, width: 400, height: 45 }, white)],
    };
    const cases = Object.entries(overlays).flatMap(([name, [original, changed]]) =>
      OVERLAY_CROPS.flatMap((shape) => [
        { name: `${name} cropped ${JSON.stringify(shape)}`, pair: [original, cropGray(changed, shape)] as const },
        { name: `original cropped ${JSON.stringify(shape)} vs ${name}`, pair: [cropGray(original, shape), changed] as const },
      ]),
    );
    const results = await Promise.all(cases.map(({ pair }) => classesOf(...pair)));
    expect(Object.fromEntries(cases.map(({ name }, i) => [name, results[i]]))).toEqual(
      Object.fromEntries(cases.map(({ name }) => [name, ['different', 'different']])),
    );
  });
});
