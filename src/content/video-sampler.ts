import { rgbaToGray } from '../fingerprint/gray.ts';
import type { GrayFrame, GrayImage } from '../shared/types.ts';

const HAVE_CURRENT_DATA = 2;
const MAX_LAG_S = 0.5;

function drawFrame(video: HTMLVideoElement, size: number): GrayImage {
  const scale = size / Math.max(video.videoWidth, video.videoHeight);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = video.ownerDocument.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('PureFeed: no 2d canvas context');
  }
  ctx.drawImage(video, 0, 0, width, height);
  return rgbaToGray(ctx.getImageData(0, 0, width, height).data, width, height);
}

export function createVideoSampler(
  video: HTMLVideoElement,
  opts: { targets: number[]; size: number; timeoutMs: number; onDone: (frames: GrayFrame[] | null) => void },
): () => void {
  const remaining = new Set(opts.targets);
  const frames: GrayFrame[] = [];
  let latest: GrayFrame | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const dispose = () => {
    clearTimeout(timeout);
    video.removeEventListener('timeupdate', onTimeUpdate);
  };

  const finish = () => {
    dispose();
    opts.onDone(remaining.size === 0 ? frames.toSorted((a, b) => a.tS - b.tS) : null);
  };

  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(finish, opts.timeoutMs);
  };

  const take = (frame: GrayFrame, targets: number[]) => {
    if (targets.length > 0 && !frames.includes(frame)) {
      frames.push(frame);
    }
    targets.forEach((target) => {
      remaining.delete(target);
    });
  };

  function onTimeUpdate() {
    const tS = video.currentTime;
    const before = remaining.size;
    const last = latest;
    if (last && tS < last.tS) {
      take(
        last,
        [...remaining].filter((target) => target > last.tS && target - last.tS <= MAX_LAG_S),
      );
    }
    const due = [...remaining].filter((target) => target <= tS && tS - target <= MAX_LAG_S);
    const isTargetAhead = [...remaining].some((target) => target > tS && target - tS <= MAX_LAG_S);
    if (video.readyState >= HAVE_CURRENT_DATA && (due.length > 0 || isTargetAhead)) {
      try {
        latest = { tS, image: drawFrame(video, opts.size) };
      } catch {
        finish();
        return;
      }
      take(latest, due);
    }
    if (remaining.size === 0) {
      finish();
      return;
    }
    if (remaining.size < before) {
      armTimeout();
    }
  }

  video.addEventListener('timeupdate', onTimeUpdate);
  armTimeout();
  return dispose;
}
