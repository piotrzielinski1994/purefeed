import { rgbaToGray } from '../fingerprint/gray.ts';
import type { FrameSource, GrayImage, SetTimer } from '../shared/types.ts';

const FRAME_SIZE = 64;

const globalTimer: SetTimer = (fn, ms) => setTimeout(fn, ms);

function eventOnce(video: HTMLVideoElement, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    video.addEventListener(type, () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error(`PureFeed: video error ${video.error?.code ?? 'unknown'}`)), { once: true });
  });
}

export async function createElementFrameSource(
  doc: Document,
  url: string,
  opts: { timeoutMs: number; setTimer?: SetTimer },
): Promise<FrameSource> {
  const video = doc.createElement('video');
  const context = Object.assign(doc.createElement('canvas'), { width: FRAME_SIZE, height: FRAME_SIZE }).getContext('2d', {
    willReadFrequently: true,
  });
  const dispose = (): void => {
    video.removeAttribute('src');
    video.load();
  };
  video.muted = true;
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';
  const loaded = eventOnce(video, 'loadedmetadata');
  const timeout = new Promise<never>((_, reject) => {
    (opts.setTimer ?? globalTimer)(() => reject(new Error(`PureFeed: no video metadata within ${opts.timeoutMs} ms`)), opts.timeoutMs);
  });
  video.src = url;
  await Promise.race([loaded, timeout]).catch((error: unknown) => {
    dispose();
    throw error;
  });
  if (!context || !Number.isFinite(video.duration) || video.duration <= 0) {
    dispose();
    throw new Error('PureFeed: video has no finite duration or no 2D context');
  }
  const readFrame = (): GrayImage => {
    context.drawImage(video, 0, 0, FRAME_SIZE, FRAME_SIZE);
    return rgbaToGray(context.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE).data, FRAME_SIZE, FRAME_SIZE);
  };
  return {
    durationS: video.duration,
    frameAt: (tS) => {
      const seeked = eventOnce(video, 'seeked');
      video.currentTime = tS;
      return seeked.then(readFrame);
    },
    dispose,
  };
}
