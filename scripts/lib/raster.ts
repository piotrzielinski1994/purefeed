import { encodePng } from './png.ts';

export type Rgb = readonly [number, number, number];
export type Paint = (x: number, y: number) => Rgb;
export type Shape = (x: number, y: number) => Rgb | null;
export type Fill = Rgb | Paint;
export type Raster = { width: number; height: number; data: Uint8Array };

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = GLYPH_WIDTH + 1;
const OPAQUE = 255;
const FONT_HEX: Record<string, string> = {
  A: '0e11111f111111',
  B: '1e11111e11111e',
  C: '0e11101010110e',
  D: '1e11111111111e',
  E: '1f10101e10101f',
  F: '1f10101e101010',
  G: '0e11101711110f',
  H: '1111111f111111',
  I: '0e04040404040e',
  J: '0702020202120c',
  K: '11121418141211',
  L: '1010101010101f',
  M: '111b1515111111',
  N: '11111915131111',
  O: '0e11111111110e',
  P: '1e11111e101010',
  Q: '0e11111115120d',
  R: '1e11111e141211',
  S: '0f10100e01011e',
  T: '1f040404040404',
  U: '1111111111110e',
  V: '11111111110a04',
  W: '1111111515150a',
  X: '11110a040a1111',
  Y: '1111110a040404',
  Z: '1f01020408101f',
  '0': '0e11131519110e',
  '1': '040c040404040e',
  '2': '0e11010204081f',
  '3': '1f02040201110e',
  '4': '02060a121f0202',
  '5': '1f101e0101110e',
  '6': '0608101e11110e',
  '7': '1f010204080808',
  '8': '0e11110e11110e',
  '9': '0e11110f01020c',
  ' ': '00000000000000',
  '.': '00000000000c0c',
  ',': '000000000c0408',
  '!': '04040404040004',
  '?': '0e110102040004',
  ':': '000c0c000c0c00',
  "'": '04040800000000',
  '-': '0000001f000000',
  '/': '01010204081010',
  '@': '0e11171517100f',
  '#': '0a0a1f0a1f0a0a',
};

export const hex = (value: string): Rgb => {
  const channel = (offset: number): number => Number.parseInt(value.slice(offset, offset + 2), 16);
  return [channel(0), channel(2), channel(4)];
};

const resolve = (fill: Fill, x: number, y: number): Rgb => (typeof fill === 'function' ? fill(x, y) : fill);

const FONT = new Map(
  Object.entries(FONT_HEX).map(([char, rows]) => [
    char,
    Array.from({ length: GLYPH_HEIGHT }, (_, row) => Number.parseInt(rows.slice(row * 2, row * 2 + 2), 16)),
  ]),
);

export const solid =
  (color: Rgb): Paint =>
  () =>
    color;

export function linearGradient(from: Rgb, to: Rgb, angleDeg: number, width: number, height: number): Paint {
  const dx = Math.cos((angleDeg * Math.PI) / 180);
  const dy = Math.sin((angleDeg * Math.PI) / 180);
  const span = Math.abs(dx) * width + Math.abs(dy) * height;
  const origin = Math.min(0, dx * width) + Math.min(0, dy * height);
  return (x, y) => {
    const t = (x * dx + y * dy - origin) / span;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
  };
}

export const layers =
  (background: Paint, ...shapes: Shape[]): Paint =>
  (x, y) =>
    shapes.reduce<Rgb>((color, shape) => shape(x, y) ?? color, background(x, y));

export const rect =
  (x0: number, y0: number, width: number, height: number, fill: Fill): Shape =>
  (x, y) =>
    x >= x0 && x < x0 + width && y >= y0 && y < y0 + height ? resolve(fill, x, y) : null;

export const ellipse =
  (cx: number, cy: number, rx: number, ry: number, fill: Fill): Shape =>
  (x, y) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 ? resolve(fill, x, y) : null;

export const circle = (cx: number, cy: number, r: number, fill: Fill): Shape => ellipse(cx, cy, r, r, fill);

export const hill =
  (baseY: number, amplitude: number, period: number, phase: number, fill: Fill): Shape =>
  (x, y) =>
    y >= baseY + amplitude * Math.sin((2 * Math.PI * x) / period + phase) ? resolve(fill, x, y) : null;

export const stripes =
  (a: Rgb, b: Rgb, period: number, angleDeg: number): Paint =>
  (x, y) => {
    const along = x * Math.cos((angleDeg * Math.PI) / 180) + y * Math.sin((angleDeg * Math.PI) / 180);
    return Math.floor(along / (period / 2)) % 2 === 0 ? a : b;
  };

export const checker =
  (a: Rgb, b: Rgb, cell: number): Paint =>
  (x, y) =>
    (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? a : b;

export const text =
  (value: string, x0: number, y0: number, scale: number, fill: Fill): Shape =>
  (x, y) => {
    const gx = Math.floor((x - x0) / scale);
    const gy = Math.floor((y - y0) / scale);
    const index = Math.floor(gx / GLYPH_ADVANCE);
    const column = gx - index * GLYPH_ADVANCE;
    if (gx < 0 || gy < 0 || gy >= GLYPH_HEIGHT || index >= value.length || column >= GLYPH_WIDTH) {
      return null;
    }
    const row = FONT.get(value.charAt(index).toUpperCase())?.[gy] ?? 0;
    return (row >> (GLYPH_WIDTH - 1 - column)) & 1 ? resolve(fill, x, y) : null;
  };

export const centeredText = (value: string, cx: number, y0: number, scale: number, fill: Fill): Shape =>
  text(value, Math.round(cx - ((value.length * GLYPH_ADVANCE - 1) * scale) / 2), y0, scale, fill);

const hashNoise = (x: number, y: number, seed: number): number => {
  const a = Math.imul(x ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(y ^ 0x61c88647, 0x27d4eb2f) ^ Math.imul(seed, 0x9e3779b1);
  const b = Math.imul(a ^ (a >>> 15), 0x85ebca6b);
  const c = Math.imul(b ^ (b >>> 13), 0xc2b2ae35);
  return ((c ^ (c >>> 16)) >>> 0) / 0xffffffff - 0.5;
};

export const noise =
  (paint: Paint, amplitude: number, seed: number): Paint =>
  (x, y) => {
    const delta = 2 * amplitude * hashNoise(x, y, seed);
    const [r, g, b] = paint(x, y);
    return [r + delta, g + delta, b + delta];
  };

export function rasterize(width: number, height: number, paint: Paint): Raster {
  const pixels = new Uint8ClampedArray(width * height * 4);
  Array.from({ length: height }, (_, y) => y).forEach((y) => {
    pixels.set(Array.from({ length: width }, (_, x) => [...paint(x, y), OPAQUE]).flat(), y * width * 4);
  });
  return { width, height, data: new Uint8Array(pixels.buffer) };
}

export const toPng = (raster: Raster): Buffer => encodePng({ ...raster, channels: 4 });
