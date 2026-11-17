import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

type BuildResult = { chromeDir: string; firefoxDir: string; chromeZip: string; firefoxZip: string };
type ContentScript = { matches?: string[]; js?: string[]; css?: string[]; run_at?: string };
type Manifest = {
  manifest_version?: number;
  minimum_chrome_version?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: ContentScript[];
  background?: { service_worker?: string; type?: string; scripts?: string[] };
  action?: { default_popup?: string };
  options_ui?: { page?: string; open_in_tab?: boolean };
  icons?: Record<string, string>;
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
};

const ROOT = join(import.meta.dirname, '..', '..');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const FORBIDDEN = ['<all_urls>', 'tabs', 'history', 'cookies', 'webRequest', 'identity'];
const EXPECTED_HOST_PERMISSIONS = [
  'https://external-preview.redd.it/*',
  'https://i.redd.it/*',
  'https://pbs.twimg.com/*',
  'https://preview.redd.it/*',
  'https://video.twimg.com/*',
  'https://www.reddit.com/*',
  'https://wykop.pl/*',
  'https://x.com/*',
];
const PLATFORM_MATCHES = ['https://www.reddit.com/*', 'https://wykop.pl/*', 'https://x.com/*'];

let buildPromise: Promise<BuildResult> | undefined;
function runBuild(): Promise<BuildResult> {
  buildPromise ??= (async () => {
    const { build } = await import('../../scripts/build.ts');
    return build({ outDir: mkdtempSync(join(tmpdir(), 'purefeed-build-')) });
  })();
  return buildPromise;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function readZip(path: string): Map<string, Buffer> {
  const buf = readFileSync(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compressedSize);
    if (!name.endsWith('/')) out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function allPermissionStrings(m: Manifest): string[] {
  return [
    ...(m.permissions ?? []),
    ...(m.optional_permissions ?? []),
    ...(m.host_permissions ?? []),
    ...(m.optional_host_permissions ?? []),
    ...(m.content_scripts ?? []).flatMap((c) => c.matches ?? []),
  ];
}

describe('build (AC-001, AC-071)', () => {
  it('should produce a Chrome dir, a Firefox dir and 2 zips if the build runs', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    expect(statSync(r.chromeDir).isDirectory()).toBe(true);
    expect(statSync(r.firefoxDir).isDirectory()).toBe(true);
    expect(existsSync(join(r.chromeDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(r.firefoxDir, 'manifest.json'))).toBe(true);
    expect(basename(r.chromeZip)).toBe(`purefeed-chrome-${VERSION}.zip`);
    expect(basename(r.firefoxZip)).toBe(`purefeed-firefox-${VERSION}.zip`);
    for (const zip of [r.chromeZip, r.firefoxZip]) {
      expect(readFileSync(zip).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
  });

  it('should pack exactly the files of each target dir if a zip is read back', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    for (const [dir, zip] of [
      [r.chromeDir, r.chromeZip],
      [r.firefoxDir, r.firefoxZip],
    ]) {
      const entries = readZip(zip);
      expect([...entries.keys()].sort()).toEqual(listFiles(dir));
      for (const [name, content] of entries) {
        expect(content.equals(readFileSync(join(dir, name))), name).toBe(true);
      }
    }
  });

  it('should declare manifest_version 3 if either manifest is read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    expect(readManifest(r.chromeDir).manifest_version).toBe(3);
    expect(readManifest(r.firefoxDir).manifest_version).toBe(3);
  });

  it('should hold no forbidden permission if either manifest is read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    for (const m of [readManifest(r.chromeDir), readManifest(r.firefoxDir)]) {
      const perms = allPermissionStrings(m);
      for (const forbidden of FORBIDDEN) expect(perms).not.toContain(forbidden);
      for (const p of perms) expect(p).not.toMatch(/^(\*|https?):\/\/\*\//);
    }
  });

  it('should list only the platform and media CDN hosts if host permissions are read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    const { HOST_PERMISSIONS } = await import('../../src/shared/hosts.ts');
    expect([...HOST_PERMISSIONS].sort()).toEqual(EXPECTED_HOST_PERMISSIONS);
    expect([...(readManifest(r.chromeDir).host_permissions ?? [])].sort()).toEqual(EXPECTED_HOST_PERMISSIONS);
    expect([...(readManifest(r.firefoxDir).host_permissions ?? [])].sort()).toEqual(EXPECTED_HOST_PERMISSIONS);
  });

  it('should export the platform hosts and media hosts of the plan if hosts module is loaded', async () => {
    const { PLATFORM_HOSTS, MEDIA_HOSTS } = await import('../../src/shared/hosts.ts');
    expect([...PLATFORM_HOSTS]).toEqual(['www.reddit.com', 'wykop.pl', 'x.com']);
    expect([...MEDIA_HOSTS]).toEqual([
      'i.redd.it',
      'preview.redd.it',
      'external-preview.redd.it',
      'wykop.pl',
      'pbs.twimg.com',
      'video.twimg.com',
    ]);
  });

  it('should inject content scripts only on the 3 platforms if either manifest is read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    for (const m of [readManifest(r.chromeDir), readManifest(r.firefoxDir)]) {
      expect(m.content_scripts).toHaveLength(1);
      const cs = m.content_scripts?.[0];
      expect([...(cs?.matches ?? [])].sort()).toEqual(PLATFORM_MATCHES);
      expect(cs?.js).toEqual(['content.js']);
      expect(cs?.css).toEqual(['content.css']);
      expect(cs?.run_at).toBe('document_idle');
    }
  });

  it('should set Chrome service worker, minimum version 120 and offscreen if the Chrome manifest is read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    const m = readManifest(r.chromeDir);
    expect(m.minimum_chrome_version).toBe('120');
    expect([...(m.permissions ?? [])].sort()).toEqual(['alarms', 'offscreen', 'storage', 'unlimitedStorage']);
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(m.action?.default_popup).toBe('popup.html');
    expect(m.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
  });

  it('should set gecko id, strict_min_version 128.0 and no offscreen if the Firefox manifest is read', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    const m = readManifest(r.firefoxDir);
    expect(m.browser_specific_settings?.gecko?.id).toBe('purefeed@purestack.local');
    expect(m.browser_specific_settings?.gecko?.strict_min_version).toBe('128.0');
    expect([...(m.permissions ?? [])].sort()).toEqual(['alarms', 'storage', 'unlimitedStorage']);
    expect(m.background?.scripts).toEqual(['background.js']);
    expect(m.background?.service_worker).toBeUndefined();
    expect(m.action?.default_popup).toBe('popup.html');
    expect(m.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
  });

  it('should ship every file a manifest references if a target dir is listed', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    for (const dir of [r.chromeDir, r.firefoxDir]) {
      const m = readManifest(dir);
      const files = new Set(listFiles(dir));
      const referenced = [
        ...(m.background?.service_worker ? [m.background.service_worker] : []),
        ...(m.background?.scripts ?? []),
        ...(m.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
        m.action?.default_popup,
        m.options_ui?.page,
        ...Object.values(m.icons ?? {}),
      ];
      expect(Object.keys(m.icons ?? {}).sort()).toEqual(['128', '16', '32', '48']);
      for (const f of referenced) expect(files, `${dir}: ${f}`).toContain(f);
    }
  });

  it('should leave no __TARGET__ identifier in any bundle if the build runs', { timeout: 300_000 }, async () => {
    const r = await runBuild();
    for (const dir of [r.chromeDir, r.firefoxDir]) {
      const scripts = listFiles(dir).filter((f) => f.endsWith('.js'));
      expect(scripts.length).toBeGreaterThan(0);
      for (const f of scripts) expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('__TARGET__');
    }
  });
});

describe('repo commands (AC-006)', () => {
  it('should exit 0 for lint, typecheck and build if run on the repo', { timeout: 600_000 }, () => {
    for (const script of ['lint', 'typecheck', 'build']) {
      const res = spawnSync('npm', ['run', script], { cwd: ROOT, encoding: 'utf8' });
      expect(res.status, `npm run ${script}\n${res.stdout}\n${res.stderr}`).toBe(0);
    }
  });

  it('should report 0 errors if npm run lint:firefox checks a fresh build (AC-003)', { timeout: 600_000 }, () => {
    const built = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
    expect(built.status, `npm run build\n${built.stdout}\n${built.stderr}`).toBe(0);
    const lint = spawnSync('npm', ['run', 'lint:firefox', '--', '--output', 'json'], { cwd: ROOT, encoding: 'utf8' });
    expect(lint.status, `npm run lint:firefox\n${lint.stdout}\n${lint.stderr}`).toBe(0);
    const report: { summary: { errors: number }; errors: Array<{ code: string }> } = JSON.parse(lint.stdout.slice(lint.stdout.indexOf('{')));
    expect(report.errors.map((e) => e.code)).toEqual([]);
    expect(report.summary.errors).toBe(0);
  });
});
