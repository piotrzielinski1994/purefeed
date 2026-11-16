import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GrayImage } from '../../src/shared/types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const GENERATED = join(ROOT, 'test', 'assets', 'generated');
const SLOW = { timeout: 900_000 };

const IMAGES = [
  'base.png',
  'base-25.png',
  'base-50.png',
  'base-200.png',
  'base-400.png',
  'base-q30.jpg',
  'base-q60.jpg',
  'base-q95.jpg',
  'base.webp',
  'base.avif',
  'base.bmp',
  'base-static.gif',
  'crop-l10-tb5.png',
  'logo5.png',
  'caption-a.png',
  'caption-b.png',
  'caption-a-small.png',
  'screenshot-1.png',
  'screenshot-2.png',
  'solid-gray.png',
  'solid-gray-2.png',
  'other-1.png',
  'other-2.png',
  'other-3.png',
];
const VIDEOS = [
  'clip.mp4',
  'clip-720.mp4',
  'clip-360.webm',
  'clip-intro.mp4',
  'clip-outro.mp4',
  'other.mp4',
  'loop.gif',
  'loop.mp4',
  'loop.webm',
];
const ALL = [...IMAGES, ...VIDEOS, 'big.mp4'];
const SCENE_MIDPOINTS = [1.25, 3.75, 6.25, 8.75, 11.25, 13.75, 16.25, 18.75];

let generated: Promise<typeof import('../helpers/assets.ts')> | undefined;
function assets(): Promise<typeof import('../helpers/assets.ts')> {
  generated ??= (async () => {
    if (!existsSync(join(GENERATED, 'manifest.json'))) {
      execFileSync('node', ['scripts/generate-assets.ts'], { cwd: ROOT, stdio: 'inherit' });
    }
    return import('../helpers/assets.ts');
  })();
  return generated;
}

function stdDev(img: GrayImage): number {
  let sum = 0;
  for (const v of img.data) sum += v;
  const mean = sum / img.data.length;
  let sq = 0;
  for (const v of img.data) sq += (v - mean) ** 2;
  return Math.sqrt(sq / img.data.length);
}

function meanAbsDiff(a: GrayImage, b: GrayImage): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}

function changedFraction(a: GrayImage, b: GrayImage): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let changed = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
  return changed / a.data.length;
}

function boxDown(img: GrayImage, f: number): GrayImage {
  const width = Math.floor(img.width / f);
  const height = Math.floor(img.height / f);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += img.data[(y * f + dy) * img.width + x * f + dx];
      data[y * width + x] = Math.round(sum / (f * f));
    }
  }
  return { width, height, data };
}

function region(img: GrayImage, x0: number, y0: number, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + width), y * width);
  return { width, height, data };
}

async function frameAt(name: string, tS: number): Promise<GrayImage> {
  const { loadFrameSource } = await assets();
  const source = loadFrameSource(name);
  const frame = await source.frameAt(tS);
  source.dispose();
  if (!frame) throw new Error(`${name}: no frame at ${tS}`);
  return frame;
}

type ProbeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number };

function probe(path: string): { streams: ProbeStream[] } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function hasMagic(name: string, buf: Buffer): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const ascii = (start: number, end: number) => buf.toString('latin1', start, end);
  switch (ext) {
    case 'png':
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'avif':
      return ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12));
    case 'bmp':
      return ascii(0, 2) === 'BM';
    case 'gif':
      return ascii(0, 4) === 'GIF8';
    case 'mp4':
      return ascii(4, 8) === 'ftyp';
    case 'webm':
      return buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default:
      return false;
  }
}

describe('synthetic test assets (AC-080)', () => {
  it('should list every planned image and video in ASSETS', SLOW, async () => {
    const { ASSETS } = await assets();
    for (const name of ALL) expect(ASSETS).toContain(name);
  });

  it('should write every asset inside test/assets/generated with its real format signature', SLOW, async () => {
    const { assetPath } = await assets();
    for (const name of ALL) {
      const path = assetPath(name);
      expect(relative(GENERATED, path).startsWith('..'), path).toBe(false);
      expect(existsSync(path), path).toBe(true);
      expect(hasMagic(name, readFileSync(path)), `${name} signature`).toBe(true);
    }
  });

  it('should record a generatorVersion in manifest.json if the generator ran', SLOW, async () => {
    await assets();
    const manifest = JSON.parse(readFileSync(join(GENERATED, 'manifest.json'), 'utf8'));
    expect(manifest.generatorVersion).toBeDefined();
    expect(manifest.generatorVersion).not.toBe('');
  });

  it('should load a raw gray decode of every image at its pixel size', SLOW, async () => {
    const { loadGray } = await assets();
    const sizes: Record<string, number> = { 'base-25.png': 150, 'base-50.png': 300, 'base-200.png': 1200, 'base-400.png': 2400 };
    for (const name of IMAGES) {
      const img = loadGray(name);
      expect(img.data).toBeInstanceOf(Uint8Array);
      expect(img.data.length, name).toBe(img.width * img.height);
      if (name === 'crop-l10-tb5.png') expect([img.width, img.height]).toEqual([540, 540]);
      else expect([img.width, img.height], name).toEqual([sizes[name] ?? 600, sizes[name] ?? 600]);
    }
  });

  it('should keep resized, recompressed and converted copies close to base.png pixels', SLOW, async () => {
    const { loadGray } = await assets();
    const base = loadGray('base.png');
    expect(meanAbsDiff(boxDown(base, 4), loadGray('base-25.png'))).toBeLessThan(20);
    expect(meanAbsDiff(boxDown(base, 2), loadGray('base-50.png'))).toBeLessThan(20);
    expect(meanAbsDiff(base, boxDown(loadGray('base-200.png'), 2))).toBeLessThan(20);
    expect(meanAbsDiff(base, boxDown(loadGray('base-400.png'), 4))).toBeLessThan(20);
    for (const name of ['base-q30.jpg', 'base-q60.jpg', 'base-q95.jpg', 'base.webp', 'base.avif', 'base.bmp', 'base-static.gif']) {
      expect(meanAbsDiff(base, loadGray(name)), name).toBeLessThan(15);
    }
  });

  it('should crop 10% from the left and 5% from top and bottom if crop-l10-tb5.png is decoded', SLOW, async () => {
    const { loadGray } = await assets();
    const cropped = loadGray('crop-l10-tb5.png');
    expect(meanAbsDiff(region(loadGray('base.png'), 60, 30, 540, 540), cropped)).toBeLessThan(2);
  });

  it('should change at most 5% of base.png pixels if logo5.png is decoded', SLOW, async () => {
    const { loadGray } = await assets();
    const fraction = changedFraction(loadGray('base.png'), loadGray('logo5.png'));
    expect(fraction).toBeGreaterThan(0.01);
    expect(fraction).toBeLessThanOrEqual(0.0505);
  });

  it('should differ only in a small caption area if caption memes are compared', SLOW, async () => {
    const { loadGray } = await assets();
    const a = loadGray('caption-a.png');
    for (const other of ['caption-b.png', 'caption-a-small.png']) {
      const fraction = changedFraction(a, loadGray(other));
      expect(fraction, other).toBeGreaterThan(0);
      expect(fraction, other).toBeLessThan(0.25);
    }
  });

  it('should differ in text only if the 2 screenshots are compared', SLOW, async () => {
    const { loadGray } = await assets();
    const fraction = changedFraction(loadGray('screenshot-1.png'), loadGray('screenshot-2.png'));
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(0.25);
  });

  it('should make solid grays flat and every other image textured', SLOW, async () => {
    const { loadGray } = await assets();
    for (const name of IMAGES) {
      const sd = stdDev(loadGray(name));
      if (name.startsWith('solid-gray')) expect(sd, name).toBeLessThan(8);
      else expect(sd, name).toBeGreaterThanOrEqual(8);
    }
  });

  it('should make unrelated control images differ from base.png and from each other', SLOW, async () => {
    const { loadGray } = await assets();
    const controls = ['base.png', 'other-1.png', 'other-2.png', 'other-3.png'].map((n) => loadGray(n));
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) expect(meanAbsDiff(controls[i], controls[j]), `${i}-${j}`).toBeGreaterThan(10);
    }
  });

  it('should encode clip as H.264 360p and 720p and as VP9 360p WebM', SLOW, async () => {
    const { assetPath } = await assets();
    const expected: Array<[string, string, number, number]> = [
      ['clip.mp4', 'h264', 640, 360],
      ['clip-720.mp4', 'h264', 1280, 720],
      ['clip-360.webm', 'vp9', 640, 360],
    ];
    for (const [name, codec, width, height] of expected) {
      const video = probe(assetPath(name)).streams.find((s) => s.codec_type === 'video');
      expect(video?.codec_name, name).toBe(codec);
      expect([video?.width, video?.height], name).toEqual([width, height]);
    }
  });

  it('should load a 96x96 raw frame source of every video at its duration', SLOW, async () => {
    const { loadFrameSource } = await assets();
    const durations: Record<string, number> = {
      'clip.mp4': 20,
      'clip-720.mp4': 20,
      'clip-360.webm': 20,
      'clip-intro.mp4': 25,
      'clip-outro.mp4': 24,
      'loop.gif': 1.5,
      'loop.mp4': 1.5,
      'loop.webm': 1.5,
    };
    for (const name of VIDEOS) {
      const source = loadFrameSource(name);
      if (durations[name] !== undefined) expect(Math.abs(source.durationS - durations[name]), name).toBeLessThanOrEqual(0.3);
      else expect(source.durationS, name).toBeGreaterThan(0);
      const frame = await source.frameAt(Math.min(1, source.durationS / 2));
      source.dispose();
      expect(frame, name).not.toBeNull();
      expect([frame?.width, frame?.height, frame?.data.length], name).toEqual([96, 96, 96 * 96]);
    }
  });

  it('should show 8 distinct scenes in clip.mp4 and the same scenes in its other encodings', SLOW, async () => {
    const frames = await Promise.all(SCENE_MIDPOINTS.map((t) => frameAt('clip.mp4', t)));
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) expect(meanAbsDiff(frames[i], frames[j]), `scene ${i}-${j}`).toBeGreaterThan(5);
    }
    for (const name of ['clip-720.mp4', 'clip-360.webm']) {
      for (let i = 0; i < SCENE_MIDPOINTS.length; i++) {
        expect(meanAbsDiff(frames[i], await frameAt(name, SCENE_MIDPOINTS[i])), `${name} scene ${i}`).toBeLessThan(12);
      }
    }
  });

  it('should prepend a 5 s intro in clip-intro.mp4 and append a 4 s outro in clip-outro.mp4', SLOW, async () => {
    for (const t of [1.25, 11.25, 18.75]) {
      const clip = await frameAt('clip.mp4', t);
      expect(meanAbsDiff(clip, await frameAt('clip-intro.mp4', t + 5)), `intro ${t}`).toBeLessThan(12);
      expect(meanAbsDiff(clip, await frameAt('clip-outro.mp4', t)), `outro ${t}`).toBeLessThan(12);
    }
    expect(meanAbsDiff(await frameAt('clip.mp4', 1.25), await frameAt('clip-intro.mp4', 1.25))).toBeGreaterThan(5);
  });

  it('should make other.mp4 unrelated to clip.mp4', SLOW, async () => {
    let total = 0;
    for (const t of [1.25, 8.75, 16.25]) total += meanAbsDiff(await frameAt('clip.mp4', t), await frameAt('other.mp4', t));
    expect(total / 3).toBeGreaterThan(10);
  });

  it('should hold 3 distinct frames in loop.gif and the same frames in its MP4 and WebM conversions', SLOW, async () => {
    const gif = await Promise.all([0.25, 0.75, 1.25].map((t) => frameAt('loop.gif', t)));
    expect(meanAbsDiff(gif[0], gif[1])).toBeGreaterThan(5);
    expect(meanAbsDiff(gif[1], gif[2])).toBeGreaterThan(5);
    expect(meanAbsDiff(gif[0], gif[2])).toBeGreaterThan(5);
    for (const name of ['loop.mp4', 'loop.webm']) {
      for (const [i, t] of [0.25, 0.75, 1.25].entries()) {
        expect(meanAbsDiff(gif[i], await frameAt(name, t)), `${name} ${t}`).toBeLessThan(15);
      }
    }
  });

  it('should make big.mp4 about 10 MB with moov before mdat', SLOW, async () => {
    const { assetPath } = await assets();
    const path = assetPath('big.mp4');
    const size = statSync(path).size;
    expect(size).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(size).toBeLessThanOrEqual(12 * 1024 * 1024);
    const buf = readFileSync(path);
    const moov = buf.indexOf('moov', 0, 'latin1');
    const mdat = buf.indexOf('mdat', 0, 'latin1');
    expect(moov).toBeGreaterThan(0);
    expect(moov).toBeLessThan(mdat);
  });

  it('should commit no media file and git-ignore the generated assets', SLOW, async () => {
    const { assetPath } = await assets();
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    expect(tracked.filter((f) => /\.(png|jpe?g|webp|avif|bmp|gif|mp4|webm)$/i.test(f))).toEqual([]);
    const ignored = spawnSync('git', ['check-ignore', '-q', relative(ROOT, assetPath('base.png')).split(sep).join('/')], {
      cwd: ROOT,
    });
    expect(ignored.status).toBe(0);
  });
});
