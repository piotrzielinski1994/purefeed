import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';

const loadCrops = () => import('./crops.ts');
const loadGrayModule = () => import('./gray.ts');
const loadPhash = () => import('./phash.ts');
const ASSET_TEST = { timeout: 60_000 };

const AXIS = [
  [0, 0],
  [0.1, 0],
  [0, 0.1],
  [0.05, 0.05],
];

function distance(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let d = 0;
  for (let i = 0; i < 2; i++) {
    let x = (a[ai + i] ^ b[bi + i]) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

describe('crop variant hashes (AC-011)', () => {
  it('should list 16 crop variants that combine 4 horizontal and 4 vertical crops', async () => {
    const { CROP_VARIANTS } = await loadCrops();
    expect(CROP_VARIANTS.length).toBe(16);
    const keys = CROP_VARIANTS.map((r) => `${r.left},${r.right},${r.top},${r.bottom}`);
    expect(new Set(keys).size).toBe(16);
    for (const [left, right] of AXIS) {
      for (const [top, bottom] of AXIS) expect(keys).toContain(`${left},${right},${top},${bottom}`);
    }
  });

  it('should hold one pHash64 of each crop variant in variant order if cropHashes is called', ASSET_TEST, async () => {
    const { CROP_VARIANTS, cropHashes } = await loadCrops();
    const { cropFraction } = await loadGrayModule();
    const { pHash64 } = await loadPhash();
    const img = loadGray('base-50.png');
    const crops = cropHashes(img);
    expect(crops).toBeInstanceOf(Uint32Array);
    expect(crops.length).toBe(32);
    CROP_VARIANTS.forEach((rect, i) => {
      expect(Array.from(crops.subarray(2 * i, 2 * i + 2)), JSON.stringify(rect)).toEqual(Array.from(pHash64(cropFraction(img, rect))));
    });
  });

  it('should hold a variant within 6 bits of the cropped copy if base.png is cut 10% left and 5% top and bottom', ASSET_TEST, async () => {
    const { cropHashes } = await loadCrops();
    const { pHash64 } = await loadPhash();
    const crops = cropHashes(loadGray('base.png'));
    const cropped = pHash64(loadGray('crop-l10-tb5.png'));
    let best = 64;
    for (let i = 0; i < 16; i++) best = Math.min(best, distance(crops, 2 * i, cropped, 0));
    expect(best).toBeLessThanOrEqual(6);
  });
});
