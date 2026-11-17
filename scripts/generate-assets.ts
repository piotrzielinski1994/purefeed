import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  centeredText,
  checker,
  circle,
  ellipse,
  hex,
  hill,
  layers,
  linearGradient,
  noise,
  type Paint,
  type Rgb,
  rasterize,
  rect,
  type Shape,
  solid,
  stripes,
  text,
  toPng,
} from './lib/raster.ts';

export const GENERATOR_VERSION = 2;
export const GENERATED_DIR = join(import.meta.dirname, '..', 'test', 'assets', 'generated');
export const FRAME_FPS = 10;
export const FRAME_SIZE = 96;

export const IMAGE_ASSETS = [
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
  'crop-r7.png',
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
] as const;
export const VIDEO_ASSETS = [
  'clip.mp4',
  'clip-720.mp4',
  'clip-360.webm',
  'clip-intro.mp4',
  'clip-outro.mp4',
  'other.mp4',
  'loop.gif',
  'loop.mp4',
  'loop.webm',
  'big.mp4',
] as const;
export const ASSETS: readonly string[] = [...IMAGE_ASSETS, ...VIDEO_ASSETS];

export type ImageMeta = { width: number; height: number };
export type VideoMeta = { durationS: number; fps: number; width: number; height: number };

const IMAGE_SIZE = 600;
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const SCENE_DURATION_S = 2.5;
const INTRO_DURATION_S = 5;
const OUTRO_DURATION_S = 4;
const LOOP_SIZE = 320;
const LOOP_FRAMES_PER_S = 2;
const BIG_BITRATE = '4M';
const IMAGE_NOISE = 8;
const VIDEO_NOISE = 4;
const CAPTION_SCALE = 6;
const SCREENSHOT_SCALE = 2;
const LOGO_SIZE = 134;
const CROP = { left: 60, top: 30, size: 540 };
const NEAR_CROP_WIDTH = 558;
const JPEG_QSCALE = { 'base-q30.jpg': 24, 'base-q60.jpg': 11, 'base-q95.jpg': 2 } as const;
const H264_BASE = ['-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const H264 = [...H264_BASE, '-crf', '23'];
const VP9 = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const execFileAsync = promisify(execFile);
const ffmpeg = (args: string[]) => execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

async function probe(path: string): Promise<{ width: number; height: number; durationS: number }> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  const info: { streams: Array<{ codec_type?: string; width?: number; height?: number }>; format: { duration?: string } } = JSON.parse(stdout);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  return { width: video?.width ?? 0, height: video?.height ?? 0, durationS: Number(info.format.duration ?? 0) };
}

const basePicture: Paint = noise(
  layers(
    linearGradient([120, 180, 235], [235, 245, 255], 90, IMAGE_SIZE, IMAGE_SIZE),
    circle(455, 125, 70, [255, 210, 60]),
    hill(330, 40, 520, 0.5, [90, 150, 80]),
    hill(420, 30, 380, 2.1, [50, 110, 50]),
    rect(70, 300, 150, 130, [190, 90, 60]),
    rect(115, 360, 45, 70, [80, 50, 30]),
    ellipse(370, 470, 95, 60, [70, 70, 75]),
    circle(445, 405, 45, [70, 70, 75]),
    circle(430, 395, 8, WHITE),
    circle(462, 395, 8, WHITE),
  ),
  IMAGE_NOISE,
  1,
);

const memePicture: Paint = noise(
  layers(
    linearGradient([240, 150, 60], [120, 40, 90], 45, IMAGE_SIZE, IMAGE_SIZE),
    ellipse(300, 380, 170, 150, [225, 190, 140]),
    circle(240, 340, 22, BLACK),
    circle(360, 340, 22, BLACK),
    ellipse(300, 430, 60, 25, [120, 60, 50]),
  ),
  IMAGE_NOISE,
  2,
);

const outlinedText = (value: string, cx: number, y0: number): Shape[] => [
  centeredText(value, cx + 3, y0 + 3, CAPTION_SCALE, BLACK),
  centeredText(value, cx, y0, CAPTION_SCALE, WHITE),
];

const caption = (top: string, bottom: string): Paint =>
  layers(memePicture, ...outlinedText(top, IMAGE_SIZE / 2, 30), ...outlinedText(bottom, IMAGE_SIZE / 2, IMAGE_SIZE - 80));

const screenshot = (lines: string[]): Paint =>
  layers(
    solid([246, 247, 249]),
    rect(0, 0, IMAGE_SIZE, 70, [29, 155, 240]),
    circle(45, 120, 28, [150, 160, 175]),
    text('PURESTACK DEV', 90, 104, 3, [20, 23, 26]),
    text('@PURESTACK', 90, 132, 2, [100, 110, 120]),
    ...lines.map((line, i) => text(line, 24, 190 + i * 26, SCREENSHOT_SCALE, [20, 23, 26])),
    rect(24, 560, 552, 2, [200, 205, 210]),
  );

const SCREENSHOT_1 = [
  'JUST SHIPPED A NEW RELEASE OF THE',
  'FEED READER. IT NOW LOADS TWICE AS',
  'FAST ON SLOW PHONES AND USES LESS',
  'MEMORY WHEN YOU SCROLL FOR A LONG',
  'TIME. THANKS TO EVERYONE WHO SENT',
  'BUG REPORTS THIS WEEK, YOU ROCK!',
  'NEXT UP: DARK MODE AND KEYBOARD',
  'SHORTCUTS FOR POWER USERS.',
  'FULL CHANGELOG IS ON THE BLOG.',
  '#RELEASE #OPENSOURCE',
  '12:41 PM - 16 NOV',
  '1,204 REPOSTS  8,311 LIKES',
];
const SCREENSHOT_2 = [
  'HOT TAKE: MOST MEETINGS COULD BE',
  'A SHORT MESSAGE. WE TRIED A WEEK',
  'WITH NO STATUS CALLS AND SHIPPED',
  'MORE THAN IN THE LAST MONTH. THE',
  'TEAM WAS CALMER AND THE REVIEWS',
  'WERE FASTER. WOULD DO IT AGAIN.',
  'WHAT DO YOU THINK, IS THIS SAFE',
  'FOR BIGGER TEAMS AS WELL?',
  'REPLIES ARE OPEN, BE NICE.',
  '#WORK #PRODUCTIVITY',
  '09:15 AM - 14 NOV',
  '3,980 REPOSTS  21,442 LIKES',
];

const IMAGE_PAINTS: Array<[string, number, number, Paint]> = [
  ['base.png', IMAGE_SIZE, IMAGE_SIZE, basePicture],
  ['crop-l10-tb5.png', CROP.size, CROP.size, (x, y) => basePicture(x + CROP.left, y + CROP.top)],
  ['crop-r7.png', NEAR_CROP_WIDTH, IMAGE_SIZE, basePicture],
  [
    'logo5.png',
    IMAGE_SIZE,
    IMAGE_SIZE,
    layers(
      basePicture,
      rect(IMAGE_SIZE - LOGO_SIZE - 10, IMAGE_SIZE - LOGO_SIZE - 10, LOGO_SIZE, LOGO_SIZE, [250, 250, 250]),
      centeredText('PF', IMAGE_SIZE - LOGO_SIZE / 2 - 10, IMAGE_SIZE - LOGO_SIZE / 2 - 31, 6, [200, 30, 40]),
    ),
  ],
  ['caption-a.png', IMAGE_SIZE, IMAGE_SIZE, caption('ME AT 3 AM', 'FIXING ONE BUG')],
  ['caption-b.png', IMAGE_SIZE, IMAGE_SIZE, caption('MY CODE IN PROD', 'NOBODY TESTED IT')],
  ['caption-a-small.png', IMAGE_SIZE, IMAGE_SIZE, caption('ME AT 3 AM', 'FIXING TWO BUG')],
  ['screenshot-1.png', IMAGE_SIZE, IMAGE_SIZE, screenshot(SCREENSHOT_1)],
  ['screenshot-2.png', IMAGE_SIZE, IMAGE_SIZE, screenshot(SCREENSHOT_2)],
  ['solid-gray.png', IMAGE_SIZE, IMAGE_SIZE, solid([128, 128, 128])],
  ['solid-gray-2.png', IMAGE_SIZE, IMAGE_SIZE, solid([200, 200, 200])],
  [
    'other-1.png',
    IMAGE_SIZE,
    IMAGE_SIZE,
    noise(layers(checker([30, 30, 40], [230, 220, 90], 75), circle(300, 300, 120, [200, 40, 60])), IMAGE_NOISE, 3),
  ],
  [
    'other-2.png',
    IMAGE_SIZE,
    IMAGE_SIZE,
    noise(
      layers(solid([15, 60, 30]), ...[260, 200, 140, 80].map((r, i) => circle(300, 300, r, i % 2 === 0 ? [240, 240, 220] : [15, 60, 30]))),
      IMAGE_NOISE,
      4,
    ),
  ],
  [
    'other-3.png',
    IMAGE_SIZE,
    IMAGE_SIZE,
    noise(layers(stripes([250, 120, 20], [40, 20, 110], 150, 30), rect(0, 420, IMAGE_SIZE, 180, [10, 10, 10])), IMAGE_NOISE, 5),
  ],
];

const SCENE_PALETTES = [
  ['0a1446', '148c96', 'fadc5a'],
  ['fa8c1e', 'ffe65a', '3c1e78'],
  ['14501e', 'a0dc3c', 'fafafa'],
  ['6e1e8c', 'fa8cc8', '141414'],
  ['000000', '8c8c8c', 'ff5050'],
  ['dc1e1e', '5a0a14', 'f0f0f0'],
  ['82c8fa', 'ffffff', '1e3ca0'],
  ['643c1e', 'f0dcb4', '14783c'],
].map((colors) => colors.map(hex));

const OTHER_PALETTES = [
  ['ffff00', '0000ff'],
  ['00ffa0', '5a0000'],
  ['ff00ff', '003c00'],
  ['fafafa', '000000'],
  ['00c8ff', '783c00'],
  ['ff7800', '00003c'],
  ['282828', 'ffc8dc'],
  ['005ac8', 'ffffa0'],
].map((colors) => colors.map(hex));

const LOOP_BACKGROUNDS = ['1e1e1e', 'ebebeb', '2878dc'].map(hex);

const clipScene = ([from, to, accent]: Rgb[], k: number): Paint =>
  noise(
    layers(
      linearGradient(from, to, k * 45, VIDEO_WIDTH, VIDEO_HEIGHT),
      circle(200 + ((k * 337) % 880), 200 + ((k * 151) % 320), 110 + 25 * (k % 3), accent),
      rect(80 + ((k * 509) % 900), 420 - ((k * 89) % 200), 260, 140, to),
      text(String(k + 1), 900 - ((k * 263) % 700), 150, 40, accent),
    ),
    VIDEO_NOISE,
    10 + k,
  );

const otherScene = ([a, b]: Rgb[], k: number): Paint => noise(stripes(a, b, 240 + k * 40, k * 23 + 10), VIDEO_NOISE, 30 + k);

const titleCard = (title: string, background: Rgb): Paint =>
  layers(solid(background), centeredText(title, VIDEO_WIDTH / 2, 290, 20, [240, 240, 240]));

const loopFrame = (background: Rgb, k: number): Paint =>
  layers(
    solid(background),
    circle(80 + k * 80, 160, 60, [250, 60, 60]),
    centeredText(String(k + 1), LOOP_SIZE / 2, 240, 8, k === 1 ? BLACK : WHITE),
  );

const writePng = (path: string, width: number, height: number, paint: Paint): void => {
  writeFileSync(path, toPng(rasterize(width, height, paint)));
};

const writeScenes = (work: string, prefix: string, palettes: Rgb[][], scene: (palette: Rgb[], k: number) => Paint): string[] =>
  palettes.map((palette, k) => {
    const path = join(work, `${prefix}-${k}.png`);
    writePng(path, VIDEO_WIDTH, VIDEO_HEIGHT, scene(palette, k));
    return path;
  });

const out = (name: string): string => join(GENERATED_DIR, name);

function sceneInputs(paths: string[], durationS: number): string[] {
  return paths.flatMap((path) => ['-loop', '1', '-framerate', String(VIDEO_FPS), '-t', String(durationS), '-i', path]);
}

function renderMaster(scenePaths: string[], boxY: number, master: string) {
  const concatInputs = scenePaths.map((_, i) => `[${i}:v]`).join('');
  const box = scenePaths.length;
  return ffmpeg([
    ...sceneInputs(scenePaths, SCENE_DURATION_S),
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=64x64:r=${VIDEO_FPS}`,
    '-filter_complex',
    `${concatInputs}concat=n=${box}:v=1:a=0,format=yuv420p,setsar=1[bg];[bg][${box}:v]overlay=x='mod(t*200,W-w)':y=${boxY}:shortest=1[v]`,
    '-map',
    '[v]',
    '-c:v',
    'ffv1',
    master,
  ]);
}

function withCard(master: string, card: string, durationS: number, position: 'before' | 'after', target: string) {
  const order = position === 'before' ? '[card][main]' : '[main][card]';
  return ffmpeg([
    ...sceneInputs([card], durationS),
    '-i',
    master,
    '-filter_complex',
    `[0:v]format=yuv420p,setsar=1[card];[1:v]setsar=1[main];${order}concat=n=2:v=1:a=0,scale=640:360[v]`,
    '-map',
    '[v]',
    ...H264,
    target,
  ]);
}

async function decodeImage(name: string): Promise<void> {
  const { width, height } = await probe(out(name));
  await ffmpeg(['-i', out(name), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', out(`${name}.gray`)]);
  writeFileSync(out(`${name}.json`), JSON.stringify({ width, height } satisfies ImageMeta));
}

async function decodeVideo(name: string): Promise<void> {
  const { durationS } = await probe(out(name));
  await ffmpeg([
    '-i',
    out(name),
    '-vf',
    `fps=${FRAME_FPS},scale=${FRAME_SIZE}:${FRAME_SIZE}:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    out(`${name}.frames.gray`),
  ]);
  writeFileSync(out(`${name}.json`), JSON.stringify({ durationS, fps: FRAME_FPS, width: FRAME_SIZE, height: FRAME_SIZE } satisfies VideoMeta));
}

export async function generateAssets(): Promise<void> {
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  mkdirSync(GENERATED_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'purefeed-assets-'));
  const intro = join(work, 'intro.png');
  const outro = join(work, 'outro.png');
  const clipMaster = join(work, 'clip.mkv');
  const otherMaster = join(work, 'other.mkv');
  const base = out('base.png');

  IMAGE_PAINTS.forEach(([name, width, height, paint]) => {
    writePng(out(name), width, height, paint);
  });
  const scenes = writeScenes(work, 'scene', SCENE_PALETTES, clipScene);
  const otherScenes = writeScenes(work, 'other', OTHER_PALETTES, otherScene);
  writePng(intro, VIDEO_WIDTH, VIDEO_HEIGHT, titleCard('INTRO', [25, 25, 35]));
  writePng(outro, VIDEO_WIDTH, VIDEO_HEIGHT, titleCard('THE END', [35, 25, 25]));
  LOOP_BACKGROUNDS.forEach((background, k) => {
    writePng(join(work, `loop-${k + 1}.png`), LOOP_SIZE, LOOP_SIZE, loopFrame(background, k));
  });

  const paletteGif = 'split[a][b];[a]palettegen[p];[b][p]paletteuse';
  await Promise.all([
    ...(
      [
        ['base-25.png', 150, 'area'],
        ['base-50.png', 300, 'area'],
        ['base-200.png', 1200, 'bicubic'],
        ['base-400.png', 2400, 'bicubic'],
      ] as const
    ).map(([name, size, flags]) => ffmpeg(['-i', base, '-vf', `scale=${size}:${size}:flags=${flags}`, out(name)])),
    ...Object.entries(JPEG_QSCALE).map(([name, q]) => ffmpeg(['-i', base, '-q:v', String(q), out(name)])),
    ffmpeg(['-i', base, '-c:v', 'libwebp', '-quality', '75', out('base.webp')]),
    ffmpeg(['-i', base, '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '30', '-cpu-used', '6', out('base.avif')]),
    ffmpeg(['-i', base, '-c:v', 'bmp', '-pix_fmt', 'bgr24', out('base.bmp')]),
    ffmpeg(['-i', base, '-vf', paletteGif, '-frames:v', '1', out('base-static.gif')]),
    ffmpeg([
      '-framerate',
      String(LOOP_FRAMES_PER_S),
      '-start_number',
      '1',
      '-i',
      join(work, 'loop-%d.png'),
      '-vf',
      paletteGif,
      '-loop',
      '0',
      out('loop.gif'),
    ]),
    renderMaster(scenes, 40, clipMaster),
    renderMaster(otherScenes, 600, otherMaster),
  ]);

  await Promise.all([
    ffmpeg(['-i', clipMaster, '-vf', 'scale=640:360', ...H264, out('clip.mp4')]),
    ffmpeg(['-i', clipMaster, ...H264, out('clip-720.mp4')]),
    ffmpeg(['-i', clipMaster, '-vf', 'scale=640:360', ...VP9, out('clip-360.webm')]),
    withCard(clipMaster, intro, INTRO_DURATION_S, 'before', out('clip-intro.mp4')),
    withCard(clipMaster, outro, OUTRO_DURATION_S, 'after', out('clip-outro.mp4')),
    ffmpeg(['-i', otherMaster, '-vf', 'scale=640:360', ...H264, out('other.mp4')]),
    ffmpeg([
      '-i',
      clipMaster,
      ...H264_BASE,
      '-b:v',
      BIG_BITRATE,
      '-minrate',
      BIG_BITRATE,
      '-maxrate',
      BIG_BITRATE,
      '-bufsize',
      BIG_BITRATE,
      '-x264-params',
      'nal-hrd=cbr',
      out('big.mp4'),
    ]),
    ffmpeg(['-i', out('loop.gif'), ...H264, out('loop.mp4')]),
    ffmpeg(['-i', out('loop.gif'), ...VP9, out('loop.webm')]),
  ]);

  await Promise.all([...IMAGE_ASSETS.map(decodeImage), ...VIDEO_ASSETS.map(decodeVideo)]);
  rmSync(work, { recursive: true, force: true });
  const files = Object.fromEntries(ASSETS.map((name) => [name, statSync(out(name)).size]));
  writeFileSync(out('manifest.json'), `${JSON.stringify({ generatorVersion: GENERATOR_VERSION, files }, null, 2)}\n`);
}

if (import.meta.main) {
  await generateAssets();
  console.log(`Generated ${ASSETS.length} assets in ${GENERATED_DIR}`);
}
