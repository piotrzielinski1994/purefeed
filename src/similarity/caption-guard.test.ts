import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import { cropGray } from '../../test/helpers/crop-sweep.ts';
import type { GrayImage, ImageFingerprint } from '../shared/types.ts';
import type { Alignment } from './image-similarity.ts';

const loadGuard = () => import('./caption-guard.ts');
const loadSimilarity = () => import('./image-similarity.ts');
const loadFingerprint = () => import('../fingerprint/image-fingerprint.ts');
const ASSET_TEST = { timeout: 60_000 };
const NONE: Alignment = { side: 'none', crop: { left: 0, right: 0, top: 0, bottom: 0 } };

function image(width: number, height: number, pixel: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return { width, height, data };
}

const background = (x: number, y: number) => Math.round(128 + 40 * Math.sin(x / 20) * Math.cos(y / 25) + ((x >> 6) + (y >> 6)) * 6);
const inCaption = (x: number, y: number) => x >= 160 && x < 224 && y >= 16 && y < 40;
const caption = (x: number, y: number) => ((x >> 2) % 2 === 0 && (y - 16) % 8 < 6 ? 10 : 250);

async function fingerprint(img: GrayImage): Promise<ImageFingerprint> {
  const { fingerprintImage } = await loadFingerprint();
  const fp = fingerprintImage(img);
  if (!fp) throw new Error('no fingerprint');
  return fp;
}

const fingerprintAsset = (name: string) => fingerprint(loadGray(name));

describe('caption guard (AC-027, AC-028)', () => {
  it('should not reject if both edge maps are identical', async () => {
    const { guardRejects } = await loadGuard();
    const fp = await fingerprint(image(256, 256, background));
    expect(guardRejects(fp.edges, new Uint32Array(fp.edges), NONE)).toBe(false);
  });

  it('should not reject if both edge maps are empty', async () => {
    const { guardRejects } = await loadGuard();
    expect(guardRejects(new Uint32Array(128), new Uint32Array(128), NONE)).toBe(false);
  });

  it('should reject if one image adds a text block on 2.3% of the area', async () => {
    const { guardRejects } = await loadGuard();
    const plain = await fingerprint(image(256, 256, background));
    const captioned = await fingerprint(image(256, 256, (x, y) => (inCaption(x, y) ? caption(x, y) : background(x, y))));
    expect(guardRejects(plain.edges, captioned.edges, NONE)).toBe(true);
    expect(guardRejects(captioned.edges, plain.edges, NONE)).toBe(true);
  });

  it('should reject if caption-a.png and caption-b.png carry different caption text', ASSET_TEST, async () => {
    const { guardRejects } = await loadGuard();
    const a = await fingerprintAsset('caption-a.png');
    const b = await fingerprintAsset('caption-b.png');
    expect(guardRejects(a.edges, b.edges, NONE)).toBe(true);
    expect(guardRejects(b.edges, a.edges, NONE)).toBe(true);
  });

  it('should not reject if base.png is compared with its recompressed and resized copies', ASSET_TEST, async () => {
    const { guardRejects } = await loadGuard();
    const base = await fingerprintAsset('base.png');
    for (const name of ['base-q30.jpg', 'base-25.png', 'base-400.png', 'base.webp']) {
      expect(guardRejects(base.edges, (await fingerprintAsset(name)).edges, NONE), name).toBe(false);
    }
  });

  it('should not reject if base.png is compared with its cropped copy at the best alignment', ASSET_TEST, async () => {
    const { guardRejects } = await loadGuard();
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    const cropped = await fingerprintAsset('crop-l10-tb5.png');
    expect(guardRejects(base.edges, cropped.edges, bestImageSimilarity(base, cropped).alignment)).toBe(false);
    expect(guardRejects(cropped.edges, base.edges, bestImageSimilarity(cropped, base).alignment)).toBe(false);
  });

  it('should not reject if base.png is compared with its copy cropped by a shape that is no crop variant', ASSET_TEST, async () => {
    const { guardRejects } = await loadGuard();
    const { bestImageSimilarity } = await loadSimilarity();
    const original = loadGray('base.png');
    const base = await fingerprint(original);
    const cropped = await fingerprint(cropGray(original, { left: 18, right: 0, top: 36, bottom: 12 }));
    expect(guardRejects(base.edges, cropped.edges, bestImageSimilarity(base, cropped).alignment)).toBe(false);
    expect(guardRejects(cropped.edges, base.edges, bestImageSimilarity(cropped, base).alignment)).toBe(false);
  });

  it('should reject if base.png is compared with its copy with a logo on 5% of the area', ASSET_TEST, async () => {
    const { guardRejects } = await loadGuard();
    const base = await fingerprintAsset('base.png');
    const logo = await fingerprintAsset('logo5.png');
    expect(guardRejects(base.edges, logo.edges, NONE)).toBe(true);
    expect(guardRejects(logo.edges, base.edges, NONE)).toBe(true);
  });
});
