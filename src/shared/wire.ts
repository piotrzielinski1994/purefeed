import type { DecodeResult, Fingerprint, GrayFrame, Sighting } from './types.ts';

export type WireFingerprint =
  | { kind: 'image'; hash: string; crops: string; edges: string }
  | { kind: 'sequence'; frames: string; timestamps: string; durationS: number }
  | { kind: 'poster'; hash: string };
export type WireGrayFrame = { tS: number; width: number; height: number; data: string };
export type WireSighting = Omit<Sighting, 'fingerprint'> & { fingerprint: WireFingerprint };
export type WireDecodeResult =
  | Exclude<DecodeResult, { status: 'ok' }>
  | (Omit<Extract<DecodeResult, { status: 'ok' }>, 'fingerprint'> & { fingerprint: WireFingerprint });

const CHAR_CODE_CHUNK = 0x8000;

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const chunks = Array.from({ length: Math.ceil(bytes.length / CHAR_CODE_CHUNK) }, (_, i) =>
    String.fromCharCode(...bytes.subarray(i * CHAR_CODE_CHUNK, (i + 1) * CHAR_CODE_CHUNK)),
  );
  return btoa(chunks.join(''));
}

const toBytes = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

function toWords(text: string): Uint32Array {
  const bytes = toBytes(text);
  return new Uint32Array(bytes.buffer, 0, bytes.length / Uint32Array.BYTES_PER_ELEMENT);
}

function toFloats(text: string): Float32Array {
  const bytes = toBytes(text);
  return new Float32Array(bytes.buffer, 0, bytes.length / Float32Array.BYTES_PER_ELEMENT);
}

export function encodeFingerprint(fp: Fingerprint): WireFingerprint {
  switch (fp.kind) {
    case 'image':
      return { kind: 'image', hash: toBase64(fp.hash), crops: toBase64(fp.crops), edges: toBase64(fp.edges) };
    case 'sequence':
      return { kind: 'sequence', frames: toBase64(fp.frames), timestamps: toBase64(fp.timestamps), durationS: fp.durationS };
    case 'poster':
      return { kind: 'poster', hash: toBase64(fp.hash) };
  }
}

export function decodeFingerprint(w: WireFingerprint): Fingerprint {
  switch (w.kind) {
    case 'image':
      return { kind: 'image', hash: toWords(w.hash), crops: toWords(w.crops), edges: toWords(w.edges) };
    case 'sequence':
      return { kind: 'sequence', frames: toWords(w.frames), timestamps: toFloats(w.timestamps), durationS: w.durationS };
    case 'poster':
      return { kind: 'poster', hash: toWords(w.hash) };
  }
}

export const encodeSighting = (sighting: Sighting): WireSighting => ({
  ...sighting,
  fingerprint: encodeFingerprint(sighting.fingerprint),
});

export const decodeSighting = (w: WireSighting): Sighting => ({ ...w, fingerprint: decodeFingerprint(w.fingerprint) });

export const encodeGrayFrame = ({ tS, image }: GrayFrame): WireGrayFrame => ({
  tS,
  width: image.width,
  height: image.height,
  data: toBase64(image.data),
});

export const decodeGrayFrame = (w: WireGrayFrame): GrayFrame => ({
  tS: w.tS,
  image: { width: w.width, height: w.height, data: toBytes(w.data) },
});

export const encodeDecodeResult = (result: DecodeResult): WireDecodeResult =>
  result.status === 'ok' ? { ...result, fingerprint: encodeFingerprint(result.fingerprint) } : result;

export const decodeDecodeResult = (w: WireDecodeResult): DecodeResult =>
  w.status === 'ok' ? { ...w, fingerprint: decodeFingerprint(w.fingerprint) } : w;
