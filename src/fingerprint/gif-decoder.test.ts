import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetPath, loadGray } from '../../test/helpers/assets.ts';

const loadGif = () => import('./gif-decoder.ts');
const loadFingerprint = () => import('./image-fingerprint.ts');
const loadHamming = () => import('../similarity/hamming.ts');
const ASSET_TEST = { timeout: 60_000 };

type Rgb = readonly [number, number, number];
type FrameSpec = {
  left?: number;
  top?: number;
  width: number;
  height: number;
  indices: ArrayLike<number>;
  delayCs?: number;
  disposal?: 0 | 1 | 2 | 3;
  transparentIndex?: number;
  interlace?: boolean;
  localPalette?: readonly Rgb[];
};
type GifSpec = { version?: '87a' | '89a'; width: number; height: number; palette: readonly Rgb[]; bgIndex?: number; frames: FrameSpec[] };

function tableBits(size: number): number {
  let bits = 1;
  while (1 << bits < size) bits++;
  return bits;
}

function colorTable(palette: readonly Rgb[]): number[] {
  const size = 1 << tableBits(palette.length);
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  return out;
}

function lzwLiteral(indices: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const width = minCodeSize + 1;
  const chunk = 1 + (clear - 3);
  const codes: number[] = [];
  for (let i = 0; i < indices.length; i += chunk) codes.push(clear, ...indices.slice(i, i + chunk));
  codes.push(clear + 1);
  const bytes: number[] = [];
  let acc = 0;
  let n = 0;
  for (const code of codes) {
    acc |= code << n;
    n += width;
    while (n >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      n -= 8;
    }
  }
  if (n > 0) bytes.push(acc & 0xff);
  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
  return out;
}

function interlaceRows(indices: number[], width: number, height: number): number[] {
  const out: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < height; y += step) out.push(...indices.slice(y * width, (y + 1) * width));
  }
  return out;
}

function buildGif(spec: GifSpec): Uint8Array {
  const version = spec.version ?? '89a';
  const le16 = (v: number) => [v & 0xff, v >> 8];
  const bytes: number[] = [...Buffer.from(`GIF${version}`, 'latin1')];
  bytes.push(...le16(spec.width), ...le16(spec.height), 0x80 | 0x70 | (tableBits(spec.palette.length) - 1), spec.bgIndex ?? 0, 0);
  bytes.push(...colorTable(spec.palette));
  for (const f of spec.frames) {
    if (version === '89a') {
      const transparent = f.transparentIndex !== undefined;
      bytes.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (transparent ? 1 : 0), ...le16(f.delayCs ?? 0), f.transparentIndex ?? 0, 0);
    }
    const local = f.localPalette;
    const packed = (local ? 0x80 | (tableBits(local.length) - 1) : 0) | (f.interlace ? 0x40 : 0);
    bytes.push(0x2c, ...le16(f.left ?? 0), ...le16(f.top ?? 0), ...le16(f.width), ...le16(f.height), packed);
    if (local) bytes.push(...colorTable(local));
    const rows = Array.from(f.indices);
    const ordered = f.interlace ? interlaceRows(rows, f.width, f.height) : rows;
    bytes.push(...lzwLiteral(ordered, Math.max(2, tableBits((local ?? spec.palette).length))));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function pixel(rgba: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return Array.from(rgba.subarray(i, i + 4));
}

function ffmpegRgbaFrames(name: string, width: number, height: number): Uint8Array[] {
  const out = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', assetPath(name), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    {
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const frameBytes = width * height * 4;
  const frames: Uint8Array[] = [];
  for (let i = 0; i + frameBytes <= out.length; i += frameBytes) frames.push(new Uint8Array(out.subarray(i, i + frameBytes)));
  return frames;
}

function maxChannelDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

function blockNoise(size: number, seed: number, levels: number): number[] {
  let x = seed >>> 0;
  const blocks: number[] = [];
  for (let i = 0; i < 64; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    blocks.push((x >>> 24) % levels);
  }
  const cell = size / 8;
  return Array.from({ length: size * size }, (_v, i) => blocks[Math.floor(Math.floor(i / size) / cell) * 8 + Math.floor((i % size) / cell)]);
}

const GRAYS: Rgb[] = [
  [0, 0, 0],
  [85, 85, 85],
  [170, 170, 170],
  [255, 255, 255],
];
const COLORS: Rgb[] = [
  [10, 20, 30],
  [200, 0, 0],
  [0, 180, 0],
  [0, 0, 220],
];

describe('GIF decoder (AC-015, AC-016)', () => {
  it('should decode every frame of loop.gif equal to the ffmpeg decode within 1 level', ASSET_TEST, async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(new Uint8Array(readFileSync(assetPath('loop.gif'))));
    expect([gif.width, gif.height]).toEqual([320, 320]);
    expect(gif.frames.length).toBe(3);
    const expected = ffmpegRgbaFrames('loop.gif', 320, 320);
    expect(expected.length).toBe(3);
    gif.frames.forEach((frame, i) => {
      expect(frame.rgba).toBeInstanceOf(Uint8ClampedArray);
      expect(frame.rgba.length).toBe(320 * 320 * 4);
      expect(maxChannelDiff(frame.rgba, expected[i]), `frame ${i}`).toBeLessThanOrEqual(1);
    });
  });

  it('should read a 500 ms delay for each frame of loop.gif', ASSET_TEST, async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(new Uint8Array(readFileSync(assetPath('loop.gif'))));
    expect(gif.frames.map((f) => f.delayMs)).toEqual([500, 500, 500]);
  });

  it('should decode the 256-color static GIF of base.png equal to the ffmpeg decode within 1 level', ASSET_TEST, async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(new Uint8Array(readFileSync(assetPath('base-static.gif'))));
    expect([gif.width, gif.height]).toEqual([600, 600]);
    expect(gif.frames.length).toBe(1);
    expect(maxChannelDiff(gif.frames[0].rgba, ffmpegRgbaFrames('base-static.gif', 600, 600)[0])).toBeLessThanOrEqual(1);
  });

  it('should decode a GIF87a image with no graphic control extension', async () => {
    const { decodeGif } = await loadGif();
    const indices = [0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 2, 2, 0, 3, 0, 3];
    const gif = decodeGif(buildGif({ version: '87a', width: 4, height: 4, palette: COLORS, frames: [{ width: 4, height: 4, indices }] }));
    expect([gif.width, gif.height]).toEqual([4, 4]);
    expect(gif.frames.length).toBe(1);
    for (const [i, index] of indices.entries()) {
      expect(pixel(gif.frames[0].rgba, 4, i % 4, Math.floor(i / 4)), `pixel ${i}`).toEqual([...COLORS[index], 255]);
    }
  });

  it('should convert the delay from hundredths of a second to milliseconds', async () => {
    const { decodeGif } = await loadGif();
    const frame = { width: 2, height: 2, indices: [0, 1, 2, 3] };
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: COLORS,
        frames: [
          { ...frame, delayCs: 7 },
          { ...frame, delayCs: 250 },
        ],
      }),
    );
    expect(gif.frames.map((f) => f.delayMs)).toEqual([70, 2500]);
  });

  it('should restore row order if the frame is interlaced', async () => {
    const { decodeGif } = await loadGif();
    const width = 2;
    const height = 19;
    const indices = Array.from({ length: width * height }, (_v, i) => Math.floor(i / width) % 4);
    const gif = decodeGif(buildGif({ width, height, palette: COLORS, frames: [{ width, height, indices, interlace: true }] }));
    for (let y = 0; y < height; y++) expect(pixel(gif.frames[0].rgba, width, 1, y), `row ${y}`).toEqual([...COLORS[y % 4], 255]);
  });

  it('should use the local color table instead of the global one if a frame carries it', async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 1,
        palette: COLORS,
        frames: [
          { width: 2, height: 1, indices: [1, 2] },
          { width: 2, height: 1, indices: [1, 2], localPalette: GRAYS },
        ],
      }),
    );
    expect(pixel(gif.frames[0].rgba, 2, 0, 0)).toEqual([...COLORS[1], 255]);
    expect(pixel(gif.frames[1].rgba, 2, 0, 0)).toEqual([...GRAYS[1], 255]);
    expect(pixel(gif.frames[1].rgba, 2, 1, 0)).toEqual([...GRAYS[2], 255]);
  });

  it('should keep the previous frame under transparent pixels and under an offset sub-image', async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(
      buildGif({
        width: 4,
        height: 4,
        palette: COLORS,
        frames: [
          { width: 4, height: 4, indices: new Array(16).fill(1), disposal: 1 },
          { left: 1, top: 1, width: 2, height: 2, indices: [0, 2, 2, 0], transparentIndex: 0, disposal: 1 },
        ],
      }),
    );
    const second = gif.frames[1].rgba;
    expect(pixel(second, 4, 0, 0)).toEqual([...COLORS[1], 255]);
    expect(pixel(second, 4, 1, 1)).toEqual([...COLORS[1], 255]);
    expect(pixel(second, 4, 2, 1)).toEqual([...COLORS[2], 255]);
    expect(pixel(second, 4, 1, 2)).toEqual([...COLORS[2], 255]);
    expect(pixel(second, 4, 2, 2)).toEqual([...COLORS[1], 255]);
    expect(pixel(second, 4, 3, 3)).toEqual([...COLORS[1], 255]);
  });

  it('should leave the previous frame in place if disposal is 0 or 1', async () => {
    const { decodeGif } = await loadGif();
    for (const disposal of [0, 1] as const) {
      const gif = decodeGif(
        buildGif({
          width: 4,
          height: 4,
          palette: COLORS,
          frames: [
            { width: 4, height: 4, indices: new Array(16).fill(1), disposal },
            { width: 2, height: 2, indices: [2, 2, 2, 2] },
          ],
        }),
      );
      expect(pixel(gif.frames[1].rgba, 4, 0, 0), `disposal ${disposal}`).toEqual([...COLORS[2], 255]);
      expect(pixel(gif.frames[1].rgba, 4, 3, 3), `disposal ${disposal}`).toEqual([...COLORS[1], 255]);
    }
  });

  it('should clear the frame area to the background if disposal is 2', async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(
      buildGif({
        width: 4,
        height: 4,
        palette: COLORS,
        bgIndex: 3,
        frames: [
          { width: 4, height: 4, indices: new Array(16).fill(1), disposal: 2 },
          { width: 2, height: 2, indices: [2, 2, 2, 2] },
        ],
      }),
    );
    expect(pixel(gif.frames[0].rgba, 4, 3, 3)).toEqual([...COLORS[1], 255]);
    expect(pixel(gif.frames[1].rgba, 4, 0, 0)).toEqual([...COLORS[2], 255]);
    const cleared = pixel(gif.frames[1].rgba, 4, 3, 3);
    expect(cleared[3] === 0 || cleared.join() === [...COLORS[3], 255].join(), `cleared pixel ${cleared.join()}`).toBe(true);
  });

  it('should restore the canvas before the frame if disposal is 3', async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(
      buildGif({
        width: 4,
        height: 4,
        palette: COLORS,
        frames: [
          { width: 4, height: 4, indices: new Array(16).fill(1), disposal: 1 },
          { width: 2, height: 2, indices: [2, 2, 2, 2], disposal: 3 },
          { left: 2, top: 2, width: 2, height: 2, indices: [3, 3, 3, 3] },
        ],
      }),
    );
    expect(pixel(gif.frames[1].rgba, 4, 0, 0)).toEqual([...COLORS[2], 255]);
    expect(pixel(gif.frames[2].rgba, 4, 0, 0)).toEqual([...COLORS[1], 255]);
    expect(pixel(gif.frames[2].rgba, 4, 3, 3)).toEqual([...COLORS[3], 255]);
  });

  it('should return frames that do not share one pixel buffer', async () => {
    const { decodeGif } = await loadGif();
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: COLORS,
        frames: [
          { width: 2, height: 2, indices: [1, 1, 1, 1] },
          { width: 2, height: 2, indices: [2, 2, 2, 2] },
        ],
      }),
    );
    expect(pixel(gif.frames[0].rgba, 2, 0, 0)).toEqual([...COLORS[1], 255]);
    expect(pixel(gif.frames[1].rgba, 2, 0, 0)).toEqual([...COLORS[2], 255]);
  });
});

describe('GIF fingerprint (AC-015)', () => {
  it('should give 3 frame fingerprints with 3 distinct timestamps if the GIF has 3 distinct frames', ASSET_TEST, async () => {
    const { decodeGif, fingerprintGif } = await loadGif();
    const fp = fingerprintGif(decodeGif(new Uint8Array(readFileSync(assetPath('loop.gif')))));
    expect(fp?.kind).toBe('sequence');
    if (fp?.kind !== 'sequence') return;
    expect(fp.frames.length).toBe(6);
    expect(fp.timestamps.length).toBe(3);
    expect(new Set(fp.timestamps).size).toBe(3);
    expect(fp.durationS).toBeCloseTo(1.5, 3);
  });

  it('should keep only distinct frames in order if the GIF repeats frames', async () => {
    const { decodeGif, fingerprintGif } = await loadGif();
    const [a, b, c] = [blockNoise(64, 1, 4), blockNoise(64, 2, 4), blockNoise(64, 3, 4)];
    const frames = [a, a, b, b, c].map((indices) => ({ width: 64, height: 64, indices, delayCs: 10 }));
    const fp = fingerprintGif(decodeGif(buildGif({ width: 64, height: 64, palette: GRAYS, frames })));
    expect(fp?.kind).toBe('sequence');
    if (fp?.kind !== 'sequence') return;
    expect(fp.timestamps.length).toBe(3);
    expect(fp.frames.length).toBe(6);
    expect(Array.from(fp.timestamps)).toEqual([...fp.timestamps].sort((x, y) => x - y));
  });

  it('should give 8 frame fingerprints spread across the timeline if the GIF has 12 distinct frames', async () => {
    const { decodeGif, fingerprintGif } = await loadGif();
    const frames = Array.from({ length: 12 }, (_v, k) => ({ width: 64, height: 64, indices: blockNoise(64, 100 + k, 4), delayCs: 10 }));
    const fp = fingerprintGif(decodeGif(buildGif({ width: 64, height: 64, palette: GRAYS, frames })));
    expect(fp?.kind).toBe('sequence');
    if (fp?.kind !== 'sequence') return;
    expect(fp.frames.length).toBe(16);
    expect(fp.timestamps.length).toBe(8);
    expect(fp.durationS).toBeCloseTo(1.2, 3);
    const ts = Array.from(fp.timestamps);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    expect(ts[0]).toBeGreaterThanOrEqual(0);
    expect(ts[0]).toBeLessThan(1.2 / 8);
    expect(ts[7]).toBeGreaterThanOrEqual((7 * 1.2) / 8);
    expect(ts[7]).toBeLessThan(1.2);
  });

  it('should give an image fingerprint close to base.png if the GIF has 1 frame', ASSET_TEST, async () => {
    const { decodeGif, fingerprintGif } = await loadGif();
    const { fingerprintImage } = await loadFingerprint();
    const { hamming64, similarityFromDistance } = await loadHamming();
    const fp = fingerprintGif(decodeGif(new Uint8Array(readFileSync(assetPath('base-static.gif')))));
    const base = fingerprintImage(loadGray('base.png'));
    expect(fp?.kind).toBe('image');
    if (fp?.kind !== 'image' || !base) return;
    expect(similarityFromDistance(hamming64(fp.hash, 0, base.hash, 0))).toBeGreaterThanOrEqual(95);
  });

  it('should return null if the GIF has 1 flat frame', async () => {
    const { decodeGif, fingerprintGif } = await loadGif();
    const gif = decodeGif(
      buildGif({ width: 64, height: 64, palette: GRAYS, frames: [{ width: 64, height: 64, indices: new Array(64 * 64).fill(2) }] }),
    );
    expect(fingerprintGif(gif)).toBeNull();
  });
});
