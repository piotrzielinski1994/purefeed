import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { build as esbuild, type Format } from 'esbuild';
import { HOST_PERMISSIONS, PLATFORM_MATCHES } from '../src/shared/hosts.ts';
import { encodePng } from './lib/png.ts';
import { createZip } from './lib/zip.ts';

type Target = 'chrome' | 'firefox';
type Entry = { in: string; out: string };
type TargetConfig = {
  esbuildTarget: string;
  background: { entry: Entry; format: Format };
  entries: Entry[];
  staticFiles: string[];
};
type ManifestPart = { permissions?: string[]; content_scripts?: Array<Record<string, unknown>>; [key: string]: unknown };
type Rgba = [number, number, number, number];

export type BuildResult = { chromeDir: string; firefoxDir: string; chromeZip: string; firefoxZip: string };

const ROOT = join(import.meta.dirname, '..');
const ICON_SIZES = [16, 32, 48, 128];
const ICON_BACKGROUND: Rgba = [32, 96, 160, 255];
const ICON_BAR: Rgba = [255, 255, 255, 255];
const ICON_BAR_FADED: Rgba = [255, 255, 255, 90];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const ICON_CORNER_RADIUS = 0.2;
const ICON_BARS = [
  { top: 0.24, bottom: 0.36, color: ICON_BAR },
  { top: 0.44, bottom: 0.56, color: ICON_BAR_FADED },
  { top: 0.64, bottom: 0.76, color: ICON_BAR },
];
const ICON_BAR_LEFT = 0.2;
const ICON_BAR_RIGHT = 0.8;

const COMMON_ENTRIES: Entry[] = [
  { in: 'src/content/main.ts', out: 'content' },
  { in: 'src/ui/popup/popup.ts', out: 'popup' },
  { in: 'src/ui/options/options.ts', out: 'options' },
  { in: 'src/decoder/hash-worker.ts', out: 'hash-worker' },
];
const COMMON_STATIC_FILES = [
  'src/content/content.css',
  'src/ui/popup/popup.html',
  'src/ui/popup/popup.css',
  'src/ui/options/options.html',
  'src/ui/options/options.css',
];
const TARGETS: Record<Target, TargetConfig> = {
  chrome: {
    esbuildTarget: 'chrome120',
    background: { entry: { in: 'src/background/main.chrome.ts', out: 'background' }, format: 'esm' },
    entries: [{ in: 'src/decoder/offscreen-main.ts', out: 'offscreen' }],
    staticFiles: ['src/decoder/offscreen.html'],
  },
  firefox: {
    esbuildTarget: 'firefox128',
    background: { entry: { in: 'src/background/main.firefox.ts', out: 'background' }, format: 'iife' },
    entries: [],
    staticFiles: [],
  },
};

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

function manifestFor(target: Target, version: string): ManifestPart {
  const base = readJson<ManifestPart>('src/manifest/base.json');
  const part = readJson<ManifestPart>(`src/manifest/${target}.json`);
  return {
    ...base,
    version,
    ...part,
    permissions: [...(base.permissions ?? []), ...(part.permissions ?? [])],
    host_permissions: HOST_PERMISSIONS,
    content_scripts: (base.content_scripts ?? []).map((script) => ({ matches: PLATFORM_MATCHES, ...script })),
  };
}

function iconPixel(x: number, y: number, size: number): Rgba {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const dx = Math.max(ICON_CORNER_RADIUS - u, u - (1 - ICON_CORNER_RADIUS), 0);
  const dy = Math.max(ICON_CORNER_RADIUS - v, v - (1 - ICON_CORNER_RADIUS), 0);
  if (Math.hypot(dx, dy) > ICON_CORNER_RADIUS) {
    return TRANSPARENT;
  }
  const bar = ICON_BARS.find((b) => v >= b.top && v <= b.bottom && u >= ICON_BAR_LEFT && u <= ICON_BAR_RIGHT);
  return bar?.color ?? ICON_BACKGROUND;
}

function writeIcons(dir: string): void {
  mkdirSync(join(dir, 'icons'));
  ICON_SIZES.forEach((size) => {
    const pixels = Array.from({ length: size * size }, (_, i) => iconPixel(i % size, Math.floor(i / size), size));
    const data = Uint8Array.from(pixels.flat());
    writeFileSync(join(dir, 'icons', `icon-${size}.png`), encodePng({ width: size, height: size, channels: 4, data }));
  });
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

async function buildTarget(target: Target, outDir: string, version: string): Promise<{ dir: string; zip: string }> {
  const config = TARGETS[target];
  const dir = join(outDir, target);
  const zip = join(outDir, `purefeed-${target}-${version}.zip`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(zip, { force: true });
  mkdirSync(dir, { recursive: true });
  const options = {
    absWorkingDir: ROOT,
    bundle: true,
    outdir: dir,
    target: config.esbuildTarget,
    define: { __TARGET__: JSON.stringify(target) },
    legalComments: 'none',
    logLevel: 'warning',
  } as const;
  await Promise.all([
    esbuild({ ...options, entryPoints: [config.background.entry], format: config.background.format }),
    esbuild({ ...options, entryPoints: [...COMMON_ENTRIES, ...config.entries], format: 'iife' }),
  ]);
  [...COMMON_STATIC_FILES, ...config.staticFiles].forEach((file) => {
    copyFileSync(join(ROOT, file), join(dir, basename(file)));
  });
  writeIcons(dir);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(target, version), null, 2)}\n`);
  writeFileSync(zip, createZip(listFiles(dir).map((name) => ({ name, data: readFileSync(join(dir, name)) }))));
  return { dir, zip };
}

export async function build(opts: { outDir: string }): Promise<BuildResult> {
  const { version } = readJson<{ version: string }>('package.json');
  const [chrome, firefox] = await Promise.all([buildTarget('chrome', opts.outDir, version), buildTarget('firefox', opts.outDir, version)]);
  return { chromeDir: chrome.dir, firefoxDir: firefox.dir, chromeZip: chrome.zip, firefoxZip: firefox.zip };
}

if (import.meta.main) {
  const result = await build({ outDir: join(ROOT, 'dist') });
  console.log(
    Object.values(result)
      .map((path) => relative(ROOT, path))
      .join('\n'),
  );
}
