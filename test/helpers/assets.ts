import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRAME_FPS, GENERATED_DIR, type ImageMeta, type VideoMeta } from '../../scripts/generate-assets.ts';
import type { FrameSource, GrayImage } from '../../src/shared/types.ts';

export { ASSETS } from '../../scripts/generate-assets.ts';

export const assetPath = (name: string): string => join(GENERATED_DIR, name);

const readMeta = <T>(name: string): T => JSON.parse(readFileSync(assetPath(`${name}.json`), 'utf8'));

export function loadGray(name: string): GrayImage {
  const { width, height } = readMeta<ImageMeta>(name);
  return { width, height, data: new Uint8Array(readFileSync(assetPath(`${name}.gray`))) };
}

export function loadFrameSource(name: string): FrameSource {
  const { durationS, width, height } = readMeta<VideoMeta>(name);
  const frames = new Uint8Array(readFileSync(assetPath(`${name}.frames.gray`)));
  const frameBytes = width * height;
  const frameCount = Math.floor(frames.length / frameBytes);
  return {
    durationS,
    frameAt: async (tS) => {
      if (tS < 0 || tS > durationS || frameCount === 0) {
        return null;
      }
      const index = Math.min(Math.round(tS * FRAME_FPS), frameCount - 1);
      return { width, height, data: frames.slice(index * frameBytes, (index + 1) * frameBytes) };
    },
    dispose: () => {},
  };
}
