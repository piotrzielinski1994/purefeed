import type { FrameSequenceFingerprint, GrayFrame } from '../shared/types.ts';
import { pHash64 } from './phash.ts';

const DEFAULT_FRAME_COUNT = 8;

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
