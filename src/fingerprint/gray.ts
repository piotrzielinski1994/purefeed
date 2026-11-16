import type { GrayImage } from '../shared/types.ts';

export type CropRect = { left: number; right: number; top: number; bottom: number };

type Tap = { index: number; weight: number };

const RGBA_CHANNELS = 4;
const LUMA_RED = 0.299;
const LUMA_GREEN = 0.587;
const LUMA_BLUE = 0.114;

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const data = Uint8Array.from({ length: width * height }, (_, i) => {
    const p = i * RGBA_CHANNELS;
    return Math.round(LUMA_RED * rgba[p] + LUMA_GREEN * rgba[p + 1] + LUMA_BLUE * rgba[p + 2]);
  });
  return { width, height, data };
}

function areaTaps(srcSize: number, dstSize: number): Tap[][] {
  const scale = srcSize / dstSize;
  return Array.from({ length: dstSize }, (_, d) => {
    const start = d * scale;
    const end = start + scale;
    const first = Math.floor(start);
    const last = Math.min(Math.ceil(end), srcSize);
    return Array.from({ length: last - first }, (_, k) => {
      const index = first + k;
      return { index, weight: (Math.min(end, index + 1) - Math.max(start, index)) / scale };
    });
  });
}

export function resizeArea(img: GrayImage, width: number, height: number): GrayImage {
  const xTaps = areaTaps(img.width, width);
  const yTaps = areaTaps(img.height, height);
  const rows = Float64Array.from({ length: img.height * width }, (_, i) => {
    const row = Math.floor(i / width) * img.width;
    return xTaps[i % width].reduce((sum, t) => sum + t.weight * img.data[row + t.index], 0);
  });
  const data = Uint8Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    return Math.round(yTaps[Math.floor(i / width)].reduce((sum, t) => sum + t.weight * rows[t.index * width + x], 0));
  });
  return { width, height, data };
}

export function cropFraction(img: GrayImage, rect: CropRect): GrayImage {
  const x0 = Math.round(img.width * rect.left);
  const x1 = Math.round(img.width * (1 - rect.right));
  const y0 = Math.round(img.height * rect.top);
  const y1 = Math.round(img.height * (1 - rect.bottom));
  const width = x1 - x0;
  const height = y1 - y0;
  const data = Uint8Array.from({ length: width * height }, (_, i) => img.data[(y0 + Math.floor(i / width)) * img.width + x0 + (i % width)]);
  return { width, height, data };
}

export function stdDev(img: GrayImage): number {
  const n = img.data.length;
  const mean = img.data.reduce((sum, v) => sum + v, 0) / n;
  return Math.sqrt(img.data.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n);
}
