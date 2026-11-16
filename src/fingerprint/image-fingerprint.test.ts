import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import type { GrayImage, ImageFingerprint } from '../shared/types.ts';

const loadFingerprint = () => import('./image-fingerprint.ts');
const loadHamming = () => import('../similarity/hamming.ts');
const ASSET_TEST = { timeout: 60_000 };

function image(width: number, height: number, pixel: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return { width, height, data };
}

function twoLevelBlocks(low: number, high: number): GrayImage {
  return image(256, 256, (x, y) => (((x >> 5) * 3 + (y >> 5) * 5) % 2 === 0 ? low : high));
}

async function fingerprintAsset(name: string): Promise<ImageFingerprint> {
  const { fingerprintImage } = await loadFingerprint();
  const fp = fingerprintImage(loadGray(name));
  if (!fp) throw new Error(`${name}: no fingerprint`);
  return fp;
}

async function hashSimilarity(a: ImageFingerprint, b: ImageFingerprint): Promise<number> {
  const { hamming64, similarityFromDistance } = await loadHamming();
  return similarityFromDistance(hamming64(a.hash, 0, b.hash, 0));
}

describe('image fingerprint (AC-008, AC-009, AC-010)', () => {
  it('should set the minimum grayscale standard deviation to 8', async () => {
    const { MIN_STD_DEV } = await loadFingerprint();
    expect(MIN_STD_DEV).toBe(8);
  });

  it('should hold a 64-bit hash, 16 crop hashes and a 64 x 64 edge map if a textured image is fingerprinted', ASSET_TEST, async () => {
    const fp = await fingerprintAsset('base.png');
    expect(fp.kind).toBe('image');
    expect(fp.hash).toBeInstanceOf(Uint32Array);
    expect(fp.hash.length).toBe(2);
    expect(fp.crops).toBeInstanceOf(Uint32Array);
    expect(fp.crops.length).toBe(32);
    expect(fp.edges).toBeInstanceOf(Uint32Array);
    expect(fp.edges.length).toBe(128);
  });

  it('should give equal fingerprints if the same pixels come from 2 different URLs', ASSET_TEST, async () => {
    const first = await fingerprintAsset('base.png');
    const second = await fingerprintAsset('base.png');
    expect(Array.from(second.hash)).toEqual(Array.from(first.hash));
    expect(Array.from(second.crops)).toEqual(Array.from(first.crops));
    expect(Array.from(second.edges)).toEqual(Array.from(first.edges));
  });

  it('should return null if the image is a solid gray', ASSET_TEST, async () => {
    const { fingerprintImage } = await loadFingerprint();
    expect(fingerprintImage(loadGray('solid-gray.png'))).toBeNull();
    expect(fingerprintImage(loadGray('solid-gray-2.png'))).toBeNull();
  });

  it('should return null if the grayscale standard deviation is below 8 and a fingerprint at 8.5', async () => {
    const { fingerprintImage } = await loadFingerprint();
    expect(fingerprintImage(twoLevelBlocks(120, 135))).toBeNull();
    expect(fingerprintImage(twoLevelBlocks(120, 137))).not.toBeNull();
  });

  it('should keep hash similarity >= 95% if base.png is resized to 25%, 50%, 200% or 400%', ASSET_TEST, async () => {
    const base = await fingerprintAsset('base.png');
    for (const name of ['base-25.png', 'base-50.png', 'base-200.png', 'base-400.png']) {
      expect(await hashSimilarity(base, await fingerprintAsset(name)), name).toBeGreaterThanOrEqual(95);
    }
  });

  it('should keep hash similarity >= 95% if base.png is recompressed as JPEG quality 30, 60, 95 or converted to WebP', ASSET_TEST, async () => {
    const base = await fingerprintAsset('base.png');
    for (const name of ['base-q30.jpg', 'base-q60.jpg', 'base-q95.jpg', 'base.webp']) {
      expect(await hashSimilarity(base, await fingerprintAsset(name)), name).toBeGreaterThanOrEqual(95);
    }
  });

  it('should keep hash similarity >= 95% if base.png is decoded from AVIF, BMP or static GIF', ASSET_TEST, async () => {
    const base = await fingerprintAsset('base.png');
    for (const name of ['base.avif', 'base.bmp', 'base-static.gif']) {
      expect(await hashSimilarity(base, await fingerprintAsset(name)), name).toBeGreaterThanOrEqual(95);
    }
  });

  it('should fingerprint a non-square image if its sides differ', async () => {
    const { fingerprintImage } = await loadFingerprint();
    const fp = fingerprintImage(image(600, 300, (x, y) => (x * 3 + ((y * 5) ^ x)) % 256));
    expect(fp?.kind).toBe('image');
    expect(fp?.hash.length).toBe(2);
  });
});
