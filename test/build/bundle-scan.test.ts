import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_PERMISSIONS } from '../../src/shared/hosts.ts';

type BuildResult = { chromeDir: string; firefoxDir: string; chromeZip: string; firefoxZip: string };

const ALLOWED_HOSTS = new Set(HOST_PERMISSIONS.map((pattern) => new URL(pattern.replace('/*', '/')).hostname));
const XML_NAMESPACE_HOSTS = new Set(['www.w3.org']);
const ANALYTICS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /\bgtag\(/,
  /segment\.(io|com)/i,
  /sentry\.io|@sentry\//i,
  /mixpanel/i,
  /amplitude\.com/i,
  /posthog/i,
  /hotjar/i,
  /plausible\.io/i,
];
const REMOTE_CODE = [
  { name: 'eval(', pattern: /(?<![\w$.])eval\s*\(/ },
  { name: 'new Function(', pattern: /new\s+Function\s*\(/ },
  { name: 'setTimeout with a string', pattern: /setTimeout\s*\(\s*['"`]/ },
  { name: 'remote import()', pattern: /import\s*\(\s*['"`]https?:/ },
  { name: 'importScripts of a URL', pattern: /importScripts\s*\(\s*['"`]https?:/ },
  { name: 'remote script element', pattern: /\.src\s*=\s*['"`]https?:\/\/[^'"`]+\.js\b/ },
];

let buildPromise: Promise<BuildResult> | undefined;
function runBuild(): Promise<BuildResult> {
  buildPromise ??= (async () => {
    const { build } = await import('../../scripts/build.ts');
    return build({ outDir: mkdtempSync(join(tmpdir(), 'purefeed-scan-')) });
  })();
  return buildPromise;
}

function bundleFiles(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (['.js', '.html', '.css', '.json'].includes(extname(entry.name)))
        out.push({ file: relative(dir, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

async function bothTargets(): Promise<Array<{ file: string; text: string }>> {
  const { chromeDir, firefoxDir } = await runBuild();
  return [
    ...bundleFiles(chromeDir).map((f) => ({ ...f, file: `chrome/${f.file}` })),
    ...bundleFiles(firefoxDir).map((f) => ({ ...f, file: `firefox/${f.file}` })),
  ];
}

describe('bundle scan (AC-072, TC-095)', () => {
  it('should hold no eval, no Function constructor and no remote code loading in any built file', { timeout: 300_000 }, async () => {
    const files = await bothTargets();
    expect(files.filter((f) => f.file.endsWith('.js')).length).toBeGreaterThanOrEqual(6);
    const hits = files.flatMap((f) => REMOTE_CODE.filter((r) => r.pattern.test(f.text)).map((r) => `${f.file}: ${r.name}`));
    expect(hits).toEqual([]);
  });

  it('should hold no analytics or telemetry endpoint or call in any built file', { timeout: 300_000 }, async () => {
    const files = await bothTargets();
    const hits = files.flatMap((f) => ANALYTICS.filter((p) => p.test(f.text)).map((p) => `${f.file}: ${p}`));
    expect(hits).toEqual([]);
  });

  it('should hold no URL literal for a host outside the AC-071 host permissions in any built file', { timeout: 300_000 }, async () => {
    const files = await bothTargets();
    const outside = files.flatMap((f) =>
      [...f.text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((host) => !ALLOWED_HOSTS.has(host) && !XML_NAMESPACE_HOSTS.has(host))
        .map((host) => `${f.file}: ${host}`),
    );
    expect([...new Set(outside)]).toEqual([]);
  });

  it('should hold no WebSocket, EventSource or sendBeacon channel in any built file', { timeout: 300_000 }, async () => {
    const files = await bothTargets();
    const hits = files.flatMap((f) =>
      [/new\s+WebSocket\s*\(/, /new\s+EventSource\s*\(/, /sendBeacon\s*\(/].filter((p) => p.test(f.text)).map((p) => `${f.file}: ${p}`),
    );
    expect(hits).toEqual([]);
  });
});
