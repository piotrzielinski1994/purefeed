import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import { CROP_WORDS } from '../../test/helpers/fingerprints.ts';
import type { ImageFingerprint } from '../shared/types.ts';

const loadSimilarity = () => import('./image-similarity.ts');
const loadFingerprint = () => import('../fingerprint/image-fingerprint.ts');
const ASSET_TEST = { timeout: 60_000 };

async function fingerprintAsset(name: string): Promise<ImageFingerprint> {
  const { fingerprintImage } = await loadFingerprint();
  const fp = fingerprintImage(loadGray(name));
  if (!fp) throw new Error(`${name}: no fingerprint`);
  return fp;
}

describe('best image similarity (AC-010, AC-011)', () => {
  it('should return 100% with no alignment if a fingerprint is compared with itself', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    const result = bestImageSimilarity(base, base);
    expect(result.similarity).toBe(100);
    expect(result.alignment.side).toBe('none');
  });

  it('should reach >= 95% if base.png is compared with its resized, recompressed and converted copies', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    for (const name of ['base-25.png', 'base-400.png', 'base-q30.jpg', 'base.webp']) {
      expect(bestImageSimilarity(base, await fingerprintAsset(name)).similarity, name).toBeGreaterThanOrEqual(95);
    }
  });

  it('should reach >= 90% if base.png is compared with its copy cropped 10% left and 5% top and bottom', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    const cropped = await fingerprintAsset('crop-l10-tb5.png');
    expect(bestImageSimilarity(base, cropped).similarity).toBeGreaterThanOrEqual(90);
    expect(bestImageSimilarity(cropped, base).similarity).toBeGreaterThanOrEqual(90);
  });

  it('should align the crop variant of the larger side if a cropped copy is compared', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    const cropped = await fingerprintAsset('crop-l10-tb5.png');
    const horizontal = { left: 0.1, right: 0 };
    const forward = bestImageSimilarity(base, cropped).alignment;
    const backward = bestImageSimilarity(cropped, base).alignment;
    expect(forward.side).toBe('a-cropped');
    expect(forward.crop).toMatchObject(horizontal);
    expect(backward.side).toBe('b-cropped');
    expect(backward.crop).toMatchObject(horizontal);
  });

  it('should reach >= 90% if base.png is compared with its copy with a logo on 5% of the area', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    const logo = await fingerprintAsset('logo5.png');
    expect(bestImageSimilarity(base, logo).similarity).toBeGreaterThanOrEqual(90);
    expect(bestImageSimilarity(logo, base).similarity).toBeGreaterThanOrEqual(90);
  });

  it('should return the same similarity if the 2 fingerprints swap places', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const names = ['base.png', 'crop-l10-tb5.png', 'logo5.png', 'other-1.png'];
    const fps = await Promise.all(names.map(fingerprintAsset));
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        expect(bestImageSimilarity(fps[i], fps[j]).similarity, `${names[i]} vs ${names[j]}`).toBe(
          bestImageSimilarity(fps[j], fps[i]).similarity,
        );
      }
    }
  });

  it('should stay below 90% if base.png is compared with unrelated control images', ASSET_TEST, async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const base = await fingerprintAsset('base.png');
    for (const name of ['other-1.png', 'other-2.png', 'other-3.png']) {
      expect(bestImageSimilarity(base, await fingerprintAsset(name)).similarity, name).toBeLessThan(90);
    }
  });

  it('should use the plain hash similarity with no alignment if every crop variant matches worse', async () => {
    const { bestImageSimilarity } = await loadSimilarity();
    const crops = new Uint32Array(CROP_WORDS).fill(0xaaaaaaaa);
    const edges = new Uint32Array(128);
    const a: ImageFingerprint = { kind: 'image', hash: Uint32Array.of(0, 0), crops, edges };
    const b: ImageFingerprint = { kind: 'image', hash: Uint32Array.of(0b1111, 0), crops, edges };
    const result = bestImageSimilarity(a, b);
    expect(result.similarity).toBeCloseTo(93.75, 6);
    expect(result.alignment.side).toBe('none');
  });
});
