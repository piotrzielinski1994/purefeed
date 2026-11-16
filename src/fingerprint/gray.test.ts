import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assetPath, loadGray } from '../../test/helpers/assets.ts';
import type { GrayImage } from '../shared/types.ts';

const loadGrayModule = () => import('./gray.ts');
const ASSET_TEST = { timeout: 60_000 };

function ffmpegRgba(name: string): Uint8Array {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', assetPath(name), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function image(width: number, height: number, pixel: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return { width, height, data };
}

describe('gray image helpers (AC-008)', () => {
  it('should keep white, black and neutral gray values if RGBA pixels are converted to gray', async () => {
    const { rgbaToGray } = await loadGrayModule();
    const rgba = Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255, 100, 100, 100, 255, 37, 37, 37, 255);
    const gray = rgbaToGray(rgba, 2, 2);
    expect([gray.width, gray.height]).toEqual([2, 2]);
    expect(gray.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(gray.data)).toEqual([255, 0, 100, 37]);
  });

  it('should accept a plain Uint8Array if RGBA pixels are converted to gray', async () => {
    const { rgbaToGray } = await loadGrayModule();
    const gray = rgbaToGray(Uint8Array.of(10, 10, 10, 255, 200, 200, 200, 255), 2, 1);
    expect(Array.from(gray.data)).toEqual([10, 200]);
  });

  it('should weight green over red over blue if pure colors are converted to gray', async () => {
    const { rgbaToGray } = await loadGrayModule();
    const [red, green, blue] = rgbaToGray(Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255), 3, 1).data;
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it('should match the ffmpeg gray decode of base.png within 1 level if its RGBA decode is converted', ASSET_TEST, async () => {
    const { rgbaToGray } = await loadGrayModule();
    const expected = loadGray('base.png');
    const gray = rgbaToGray(ffmpegRgba('base.png'), expected.width, expected.height);
    expect([gray.width, gray.height]).toEqual([expected.width, expected.height]);
    let worst = 0;
    for (let i = 0; i < expected.data.length; i++) worst = Math.max(worst, Math.abs(gray.data[i] - expected.data[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('should average whole source blocks if an image is downscaled by an integer factor with resizeArea', async () => {
    const { resizeArea } = await loadGrayModule();
    const src = { width: 4, height: 2, data: Uint8Array.of(0, 100, 10, 30, 200, 100, 50, 70) };
    const out = resizeArea(src, 2, 1);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(out.data.length).toBe(2);
    expect(Math.abs(out.data[0] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[1] - 40)).toBeLessThanOrEqual(1);
  });

  it('should weight partly covered source pixels by area if the scale factor is not an integer', async () => {
    const { resizeArea } = await loadGrayModule();
    const out = resizeArea({ width: 3, height: 1, data: Uint8Array.of(0, 90, 180) }, 2, 1);
    expect(Math.abs(out.data[0] - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[1] - 150)).toBeLessThanOrEqual(1);
  });

  it('should repeat source pixels if an image is upscaled by an integer factor with resizeArea', async () => {
    const { resizeArea } = await loadGrayModule();
    const out = resizeArea({ width: 2, height: 2, data: Uint8Array.of(10, 60, 120, 250) }, 4, 4);
    expect([out.width, out.height]).toEqual([4, 4]);
    const expected = [10, 10, 60, 60, 10, 10, 60, 60, 120, 120, 250, 250, 120, 120, 250, 250];
    for (let i = 0; i < expected.length; i++) expect(Math.abs(out.data[i] - expected[i]), `pixel ${i}`).toBeLessThanOrEqual(1);
  });

  it('should keep a constant image constant if it is resized to any size', async () => {
    const { resizeArea } = await loadGrayModule();
    const flat = image(37, 23, () => 77);
    for (const [w, h] of [
      [32, 32],
      [64, 9],
      [100, 100],
    ]) {
      const out = resizeArea(flat, w, h);
      expect(out.data.length).toBe(w * h);
      expect(new Set(out.data)).toEqual(new Set([77]));
    }
  });

  it('should cut the given fraction from each edge if cropFraction is called', async () => {
    const { cropFraction } = await loadGrayModule();
    const src = image(10, 10, (x, y) => y * 10 + x);
    const out = cropFraction(src, { left: 0.1, right: 0.2, top: 0, bottom: 0.3 });
    expect([out.width, out.height]).toEqual([7, 7]);
    expect(out.data[0]).toBe(1);
    expect(out.data[6]).toBe(7);
    expect(out.data[7]).toBe(11);
    expect(out.data[48]).toBe(67);
  });

  it('should return the same pixels if cropFraction gets a zero crop', async () => {
    const { cropFraction } = await loadGrayModule();
    const src = image(6, 4, (x, y) => x * 7 + y * 31);
    const out = cropFraction(src, { left: 0, right: 0, top: 0, bottom: 0 });
    expect([out.width, out.height]).toEqual([6, 4]);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('should give 0 for a flat image and 127.5 for a half black half white image if stdDev is called', async () => {
    const { stdDev } = await loadGrayModule();
    expect(stdDev(image(50, 50, () => 128))).toBe(0);
    expect(stdDev(image(100, 100, (x) => (x < 50 ? 0 : 255)))).toBeCloseTo(127.5, 1);
    expect(stdDev(image(100, 100, (x) => (x % 2 === 0 ? 120 : 136)))).toBeCloseTo(8, 1);
  });
});
