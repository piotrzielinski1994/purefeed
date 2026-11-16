import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, GENERATOR_VERSION, generateAssets } from '../scripts/generate-assets.ts';

export default async function setup(): Promise<void> {
  const manifestPath = join(GENERATED_DIR, 'manifest.json');
  const manifest: { generatorVersion?: unknown } = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  if (manifest.generatorVersion !== GENERATOR_VERSION) {
    await generateAssets();
  }
}
