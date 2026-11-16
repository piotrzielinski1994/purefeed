import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import type { GrayImage } from '../shared/types.ts';

const loadPhash = () => import('./phash.ts');
const ASSET_TEST = { timeout: 60_000 };

function distance(a: Uint32Array, b: Uint32Array): number {
  let d = 0;
  for (let i = 0; i < 2; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

function copy(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
}

describe('pHash64 (AC-008, AC-010)', () => {
  it('should return 2 words of 64 bits if an image is hashed', ASSET_TEST, async () => {
    const { pHash64 } = await loadPhash();
    const hash = pHash64(loadGray('base.png'));
    expect(hash).toBeInstanceOf(Uint32Array);
    expect(hash.length).toBe(2);
  });

  it('should return equal hashes if 2 copies of the same pixels are hashed', ASSET_TEST, async () => {
    const { pHash64 } = await loadPhash();
    const base = loadGray('base.png');
    expect(Array.from(pHash64(copy(base)))).toEqual(Array.from(pHash64(base)));
  });

  it('should keep the hash within 3 bits if base.png is resized to 25% or 400%', ASSET_TEST, async () => {
    const { pHash64 } = await loadPhash();
    const base = pHash64(loadGray('base.png'));
    for (const name of ['base-25.png', 'base-400.png']) expect(distance(base, pHash64(loadGray(name))), name).toBeLessThanOrEqual(3);
  });

  it('should differ by more than 7 bits if unrelated images are hashed', ASSET_TEST, async () => {
    const { pHash64 } = await loadPhash();
    const hashes = ['base.png', 'other-1.png', 'other-2.png', 'other-3.png'].map((name) => pHash64(loadGray(name)));
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) expect(distance(hashes[i], hashes[j]), `${i} vs ${j}`).toBeGreaterThan(7);
    }
  });
});
