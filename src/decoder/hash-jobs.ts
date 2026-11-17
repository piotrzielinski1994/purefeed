import { fingerprintSequence } from '../fingerprint/frame-sequence.ts';
import { decodeGif, fingerprintGif } from '../fingerprint/gif-decoder.ts';
import { fingerprintImage } from '../fingerprint/image-fingerprint.ts';
import type { DecodeResult, Fingerprint, GrayImage } from '../shared/types.ts';
import type { WorkerJob } from './worker-client.ts';

export type ToGray = (bytes: ArrayBuffer, mime: string) => Promise<GrayImage>;

const GIF_SIGNATURE = 'GIF8';
const UNREADABLE: DecodeResult = { status: 'skipped', reason: 'unreadable' };

const isGif = (bytes: ArrayBuffer): boolean =>
  String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(GIF_SIGNATURE.length, bytes.byteLength))) === GIF_SIGNATURE;

const imageResult = (fp: Fingerprint | null): DecodeResult =>
  fp ? { status: 'ok', contentType: fp.kind === 'sequence' ? 'gif' : 'image', fingerprint: fp } : { status: 'skipped', reason: 'flat' };

function gifFingerprint(bytes: ArrayBuffer): Fingerprint | null {
  const gif = decodeGif(new Uint8Array(bytes));
  if (gif.frames.length === 0) {
    throw new Error('PureFeed: GIF without frames');
  }
  return fingerprintGif(gif);
}

function hashImage(bytes: ArrayBuffer, mime: string, toGray: ToGray): Promise<DecodeResult> {
  const fingerprint = isGif(bytes) ? Promise.resolve(bytes).then(gifFingerprint) : toGray(bytes, mime).then(fingerprintImage);
  return fingerprint.then(imageResult, () => UNREADABLE);
}

export const runJob = (job: WorkerJob, toGray: ToGray): Promise<DecodeResult> =>
  job.op === 'image'
    ? hashImage(job.bytes, job.mime, toGray)
    : Promise.resolve({ status: 'ok', contentType: 'video', fingerprint: fingerprintSequence(job.frames, job.durationS) });
