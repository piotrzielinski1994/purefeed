import { describe, expect, it } from 'vitest';
import type { ImageFingerprint, Thresholds } from '../../src/shared/types.ts';
import { loadGray } from '../helpers/assets.ts';

const loadCompare = () => import('../../src/similarity/compare.ts');
const loadFingerprint = () => import('../../src/fingerprint/image-fingerprint.ts');
const ASSET_TEST = { timeout: 120_000 };
const DEFAULTS: Thresholds = { exact: 95, near: 90 };

async function fingerprintAsset(name: string): Promise<ImageFingerprint> {
  const { fingerprintImage } = await loadFingerprint();
  const fp = fingerprintImage(loadGray(name));
  if (!fp) throw new Error(`${name}: no fingerprint`);
  return fp;
}

async function classify(a: string, b: string): Promise<[string, string]> {
  const { compareFingerprints } = await loadCompare();
  const fa = await fingerprintAsset(a);
  const fb = await fingerprintAsset(b);
  return [compareFingerprints(fa, fb, DEFAULTS).matchClass, compareFingerprints(fb, fa, DEFAULTS).matchClass];
}

describe('false-positive guard on generated assets (AC-027, AC-028)', () => {
  it('should return different if caption-a.png and caption-b.png share the picture but not the caption', ASSET_TEST, async () => {
    expect(await classify('caption-a.png', 'caption-b.png')).toEqual(['different', 'different']);
  });

  it('should return different if the caption text area of caption-a.png changes by 1% of the image', ASSET_TEST, async () => {
    expect(await classify('caption-a.png', 'caption-a-small.png')).toEqual(['different', 'different']);
  });

  it('should return different if screenshot-1.png and screenshot-2.png share layout, size and background', ASSET_TEST, async () => {
    expect(await classify('screenshot-1.png', 'screenshot-2.png')).toEqual(['different', 'different']);
  });

  it('should return exact if a caption meme or a screenshot is compared with itself', ASSET_TEST, async () => {
    for (const name of ['caption-a.png', 'screenshot-1.png']) expect(await classify(name, name), name).toEqual(['exact', 'exact']);
  });
});

describe('match class regression on generated assets (AC-010, AC-011, AC-023)', () => {
  it('should return exact if base.png is compared with its resized, recompressed and converted copies', ASSET_TEST, async () => {
    const copies = ['base-25.png', 'base-50.png', 'base-200.png', 'base-400.png', 'base-q30.jpg', 'base-q60.jpg', 'base-q95.jpg'];
    for (const name of [...copies, 'base.webp', 'base.avif', 'base.bmp', 'base-static.gif']) {
      expect(await classify('base.png', name), name).toEqual(['exact', 'exact']);
    }
  });

  it('should return exact or near if base.png is compared with its cropped copy or its copy with a logo', ASSET_TEST, async () => {
    for (const name of ['crop-l10-tb5.png', 'logo5.png']) {
      for (const matchClass of await classify('base.png', name)) expect(['exact', 'near'], name).toContain(matchClass);
    }
  });

  it('should return different if unrelated control images are compared with base.png or with each other', ASSET_TEST, async () => {
    const names = ['base.png', 'other-1.png', 'other-2.png', 'other-3.png'];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        expect(await classify(names[i], names[j]), `${names[i]} vs ${names[j]}`).toEqual(['different', 'different']);
      }
    }
  });
});
