import type { DecodeRequest, DecodeResult, GrayFrame } from '../shared/types.ts';
import { decodeGrayFrame, encodeDecodeResult, encodeGrayFrame, type WireDecodeResult, type WireGrayFrame } from '../shared/wire.ts';
import type { DecoderHost } from './decoder-host.ts';

export type OffscreenMessage =
  | { target: 'offscreen'; op: 'decode'; req: DecodeRequest }
  | { target: 'offscreen'; op: 'frames'; frames: WireGrayFrame[]; durationS: number; posterUrl: string | null };

const UNREADABLE: DecodeResult = { status: 'skipped', reason: 'unreadable' };

export const isOffscreenMessage = (message: unknown): message is OffscreenMessage =>
  typeof message === 'object' &&
  message !== null &&
  'target' in message &&
  message.target === 'offscreen' &&
  'op' in message &&
  (message.op === 'decode' || message.op === 'frames');

export const decodeMessage = (req: DecodeRequest): OffscreenMessage => ({ target: 'offscreen', op: 'decode', req });

export const framesMessage = (frames: GrayFrame[], durationS: number, posterUrl: string | null): OffscreenMessage => ({
  target: 'offscreen',
  op: 'frames',
  frames: frames.map(encodeGrayFrame),
  durationS,
  posterUrl,
});

export function handleOffscreenMessage(host: DecoderHost, message: OffscreenMessage): Promise<WireDecodeResult> {
  const result =
    message.op === 'decode'
      ? host.decode(message.req)
      : host.hashFrames(message.frames.map(decodeGrayFrame), message.durationS, message.posterUrl);
  return result.catch(() => UNREADABLE).then(encodeDecodeResult);
}
