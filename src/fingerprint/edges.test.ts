import { describe, expect, it } from 'vitest';
import type { GrayImage } from '../shared/types.ts';

const loadEdges = () => import('./edges.ts');

function image(width: number, height: number, pixel: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return { width, height, data };
}

function bitCount(words: Uint32Array): number {
  let n = 0;
  for (const w of words) {
    let x = w;
    while (x) {
      n += x & 1;
      x >>>= 1;
    }
  }
  return n;
}

describe('edge map (AC-027, AC-028)', () => {
  it('should return 128 words (64 x 64 bits) if an image is mapped', async () => {
    const { edgeMap64 } = await loadEdges();
    const map = edgeMap64(image(256, 256, (x) => (x < 128 ? 0 : 255)));
    expect(map).toBeInstanceOf(Uint32Array);
    expect(map.length).toBe(128);
  });

  it('should set no bit if the image is flat', async () => {
    const { edgeMap64 } = await loadEdges();
    expect(bitCount(edgeMap64(image(256, 256, () => 90)))).toBe(0);
  });

  it('should set about one 64-cell line of bits if the image holds one strong straight edge', async () => {
    const { edgeMap64 } = await loadEdges();
    const vertical = bitCount(edgeMap64(image(256, 256, (x) => (x < 128 ? 0 : 255))));
    const horizontal = bitCount(edgeMap64(image(256, 256, (_x, y) => (y < 128 ? 0 : 255))));
    expect(vertical).toBeGreaterThanOrEqual(60);
    expect(vertical).toBeLessThanOrEqual(4 * 64);
    expect(horizontal).toBe(vertical);
  });

  it('should set more bits if the image holds more edges', async () => {
    const { edgeMap64 } = await loadEdges();
    const one = bitCount(edgeMap64(image(256, 256, (x) => (x < 128 ? 0 : 255))));
    const many = bitCount(edgeMap64(image(256, 256, (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? 0 : 255))));
    expect(many).toBeGreaterThan(4 * one);
  });

  it('should set a full line of bits at any position of a weak edge relative to the 4-pixel cell grid', async () => {
    const { edgeMap64 } = await loadEdges();
    const weakStepAt = (edge: number) => image(256, 256, (x) => (x < edge ? 100 : 160));
    const counts = [128, 129, 130, 131].map((edge) => bitCount(edgeMap64(weakStepAt(edge))));
    expect(counts.every((n) => n >= 64)).toBe(true);
  });

  it('should return equal maps if 2 copies of the same pixels are mapped', async () => {
    const { edgeMap64 } = await loadEdges();
    const make = () => image(300, 200, (x, y) => (x * 7 + y * 13) % 256);
    expect(Array.from(edgeMap64(make()))).toEqual(Array.from(edgeMap64(make())));
  });
});
