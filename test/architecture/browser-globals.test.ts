import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const BIOME = join(ROOT, 'node_modules', '.bin', 'biome');
const COMPAT_MODULE = join(ROOT, 'src', 'compat', 'browser.ts');
const GLOBAL_ACCESS = [
  /\bglobalThis\s*\.\s*(chrome|browser)\b/,
  /\bself\s*\.\s*(chrome|browser)\b/,
  /\bwindow\s*\.\s*(chrome|browser)\b/,
  /\[\s*['"`](chrome|browser)['"`]\s*\]/,
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs|html)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

function lintProbe(probePath: string, code: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'purefeed-biome-'));
  copyFileSync(join(ROOT, 'biome.json'), join(dir, 'biome.json'));
  const file = join(dir, probePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, code);
  const res = spawnSync(BIOME, ['lint', '--vcs-enabled=false', probePath], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describe('browser globals (AC-004)', () => {
  it('should report noRestrictedGlobals if chrome or browser is used outside src/compat', { timeout: 60_000 }, () => {
    expect(existsSync(join(ROOT, 'biome.json')), 'biome.json').toBe(true);
    for (const code of ['chrome.runtime.id;\n', 'browser.runtime.id;\n']) {
      const res = lintProbe('src/probe.ts', code);
      expect(res.status, res.output).not.toBe(0);
      expect(res.output).toContain('noRestrictedGlobals');
    }
  });

  it('should allow chrome and browser globals if used inside src/compat', { timeout: 60_000 }, () => {
    expect(existsSync(join(ROOT, 'biome.json')), 'biome.json').toBe(true);
    const res = lintProbe('src/compat/probe.ts', 'chrome.runtime.id;\nbrowser.runtime.id;\n');
    expect(res.output).not.toContain('noRestrictedGlobals');
    expect(res.status, res.output).toBe(0);
  });

  it('should find global chrome or browser access only in src/compat if src is scanned', () => {
    const compatSource = readFileSync(COMPAT_MODULE, 'utf8');
    expect(compatSource).toMatch(/\bchrome\b/);
    expect(compatSource).toMatch(/\bbrowser\b/);
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (rel.startsWith('src/compat/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of GLOBAL_ACCESS) if (pattern.test(text)) offenders.push(`${rel}: ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });
});
