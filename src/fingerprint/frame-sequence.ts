import type { FrameSequenceFingerprint, FrameSource, GrayFrame, GrayImage } from '../shared/types.ts';
import { pHash64 } from './phash.ts';

const DEFAULT_FRAME_COUNT = 8;
const DEFAULT_DEADLINE_MS = 10_000;

export const sampleTimestamps = (durationS: number, count = DEFAULT_FRAME_COUNT): number[] =>
  Array.from({ length: count }, (_, i) => ((i + 0.5) * durationS) / count);

export function fingerprintSequence(frames: readonly GrayFrame[], durationS: number): FrameSequenceFingerprint {
  return {
    kind: 'sequence',
    frames: Uint32Array.from(frames.flatMap((f) => Array.from(pHash64(f.image)))),
    timestamps: Float32Array.from(frames, (f) => f.tS),
    durationS,
  };
}

function frameBefore(src: FrameSource, tS: number, remainingMs: number): Promise<GrayImage | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, remainingMs));
  });
  return Promise.race([src.frameAt(tS), timeout]).finally(() => clearTimeout(timer));
}

export async function fingerprintFrameSource(
  src: FrameSource,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<FrameSequenceFingerprint | null> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  const remaining = (): number => deadlineMs - (now() - start);
  const frames: GrayFrame[] = [];
  for (const tS of sampleTimestamps(src.durationS)) {
    const image = await frameBefore(src, tS, remaining());
    if (remaining() <= 0) {
      break;
    }
    if (image) {
      frames.push({ tS, image });
    }
  }
  return frames.length === 0 ? null : fingerprintSequence(frames, src.durationS);
}
