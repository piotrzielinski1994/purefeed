import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ENGINE_DIRS = ['src/engine', 'src/similarity', 'src/repository', 'src/fingerprint'];
const ENGINE_ALLOWED = [...ENGINE_DIRS, 'src/shared'];
const ADAPTER_FORBIDDEN = [...ENGINE_DIRS, 'src/background'];

function modules(dirs: string[]): string[] {
  return dirs
    .filter((d) => existsSync(join(ROOT, d)))
    .flatMap((d) =>
      readdirSync(join(ROOT, d), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
        .map((e) => relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/')),
    )
    .sort();
}

async function bundleInputs(entry: string): Promise<string[]> {
  const res = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: { __TARGET__: '"chrome"' },
  });
  return Object.keys(res.metafile.inputs);
}

describe('engine dependencies (AC-005)', () => {
  it('should check the shared message contract, wire codec and domain types with the engine modules', () => {
    const checked = modules(ENGINE_ALLOWED);
    expect(checked).toContain('src/shared/messages.ts');
    expect(checked).toContain('src/shared/wire.ts');
    expect(checked).toContain('src/shared/types.ts');
  });

  it('should bundle engine modules only from engine dirs and src/shared if esbuild metafile is read', { timeout: 120_000 }, async () => {
    const entries = modules(ENGINE_ALLOWED);
    expect(entries.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const entry of entries) {
      for (const input of await bundleInputs(entry)) {
        if (!ENGINE_ALLOWED.some((d) => input.startsWith(`${d}/`))) violations.push(`${entry} -> ${input}`);
      }
    }
    for (const entry of modules(['src/adapters'])) {
      for (const input of await bundleInputs(entry)) {
        if (ADAPTER_FORBIDDEN.some((d) => input.startsWith(`${d}/`))) violations.push(`${entry} -> ${input}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
