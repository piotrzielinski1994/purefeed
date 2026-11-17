import type { DecodeRequest, DecodeResult, GrayFrame } from '../shared/types.ts';

export type DecoderHost = {
  decode(req: DecodeRequest): Promise<DecodeResult>;
  hashFrames(frames: GrayFrame[], durationS: number, posterUrl: string | null): Promise<DecodeResult>;
};
