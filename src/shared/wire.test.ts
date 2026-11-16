import { describe, expect, it } from 'vitest';
import type { DecodeResult, FrameSequenceFingerprint, GrayFrame, ImageFingerprint, PosterFingerprint, Sighting } from './types.ts';

const loadWire = () => import('./wire.ts');

function words(n: number, seed: number): Uint32Array {
  const out = new Uint32Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x;
  }
  if (n > 0) out[0] = 0xffffffff;
  if (n > 1) out[1] = 0x80000000;
  if (n > 2) out[2] = 0;
  return out;
}

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function imageFp(): ImageFingerprint {
  return { kind: 'image', hash: words(2, 1), crops: words(32, 2), edges: words(128, 3) };
}

function sequenceFp(frameCount: number): FrameSequenceFingerprint {
  const timestamps = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) timestamps[i] = ((i + 0.5) * 20.3) / frameCount;
  return { kind: 'sequence', frames: words(frameCount * 2, 4), timestamps, durationS: 20.3 };
}

function posterFp(): PosterFingerprint {
  return { kind: 'poster', hash: words(2, 5) };
}

describe('wire codec (AC-005)', () => {
  it('should keep every word of an image fingerprint if it crosses JSON messaging', async () => {
    const { encodeFingerprint, decodeFingerprint } = await loadWire();
    const fp = imageFp();
    const back = decodeFingerprint(viaJson(encodeFingerprint(fp))) as ImageFingerprint;
    expect(back.kind).toBe('image');
    expect(back.hash).toBeInstanceOf(Uint32Array);
    expect(back.crops).toBeInstanceOf(Uint32Array);
    expect(back.edges).toBeInstanceOf(Uint32Array);
    expect(Array.from(back.hash)).toEqual(Array.from(fp.hash));
    expect(Array.from(back.crops)).toEqual(Array.from(fp.crops));
    expect(Array.from(back.edges)).toEqual(Array.from(fp.edges));
  });

  it('should keep frames, timestamps and duration of a frame sequence if it crosses JSON messaging', async () => {
    const { encodeFingerprint, decodeFingerprint } = await loadWire();
    for (const frameCount of [8, 3, 1]) {
      const fp = sequenceFp(frameCount);
      const back = decodeFingerprint(viaJson(encodeFingerprint(fp))) as FrameSequenceFingerprint;
      expect(back.kind).toBe('sequence');
      expect(back.frames).toBeInstanceOf(Uint32Array);
      expect(back.timestamps).toBeInstanceOf(Float32Array);
      expect(Array.from(back.frames)).toEqual(Array.from(fp.frames));
      expect(Array.from(back.timestamps)).toEqual(Array.from(fp.timestamps));
      expect(back.durationS).toBe(20.3);
    }
  });

  it('should keep a poster-only fingerprint as poster kind if it crosses JSON messaging', async () => {
    const { encodeFingerprint, decodeFingerprint } = await loadWire();
    const fp = posterFp();
    const back = decodeFingerprint(viaJson(encodeFingerprint(fp))) as PosterFingerprint;
    expect(back.kind).toBe('poster');
    expect(back.hash).toBeInstanceOf(Uint32Array);
    expect(Array.from(back.hash)).toEqual(Array.from(fp.hash));
  });

  it('should keep every field of a sighting if it crosses JSON messaging', async () => {
    const { encodeSighting, decodeSighting } = await loadWire();
    const fpIn = imageFp();
    const sighting: Sighting = {
      fingerprint: fpIn,
      contentType: 'image',
      platform: 'wykop',
      postKey: 'wykop:entry:123',
      permalink: 'https://wykop.pl/wpis/123/x',
    };
    const back = decodeSighting(viaJson(encodeSighting(sighting)));
    expect(back.contentType).toBe('image');
    expect(back.platform).toBe('wykop');
    expect(back.postKey).toBe('wykop:entry:123');
    expect(back.permalink).toBe('https://wykop.pl/wpis/123/x');
    const fp = back.fingerprint as ImageFingerprint;
    expect(fp.kind).toBe('image');
    expect(Array.from(fp.hash)).toEqual(Array.from(fpIn.hash));
    expect(Array.from(fp.edges)).toEqual(Array.from(fpIn.edges));
  });

  it('should keep pixel bytes, size and timestamp of a gray frame if byte length is not a multiple of 3', async () => {
    const { encodeGrayFrame, decodeGrayFrame } = await loadWire();
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [2, 1],
      [4, 1],
      [5, 1],
      [96, 96],
    ]) {
      const data = new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 255) % 256;
      const frame: GrayFrame = { tS: 3.75, image: { width, height, data } };
      const back = decodeGrayFrame(viaJson(encodeGrayFrame(frame)));
      expect(back.tS).toBe(3.75);
      expect(back.image.width).toBe(width);
      expect(back.image.height).toBe(height);
      expect(back.image.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(back.image.data)).toEqual(Array.from(data));
    }
  });

  it('should keep an ok decode result with its fingerprint if it crosses JSON messaging', async () => {
    const { encodeDecodeResult, decodeDecodeResult } = await loadWire();
    const result: DecodeResult = { status: 'ok', contentType: 'video', fingerprint: sequenceFp(8) };
    const back = decodeDecodeResult(viaJson(encodeDecodeResult(result)));
    expect(back.status).toBe('ok');
    if (back.status !== 'ok' || result.status !== 'ok') throw new Error('status');
    expect(back.contentType).toBe('video');
    const fp = back.fingerprint as FrameSequenceFingerprint;
    const orig = result.fingerprint as FrameSequenceFingerprint;
    expect(fp.kind).toBe('sequence');
    expect(Array.from(fp.frames)).toEqual(Array.from(orig.frames));
    expect(Array.from(fp.timestamps)).toEqual(Array.from(orig.timestamps));
  });

  it('should keep the reason of a skipped decode result if it crosses JSON messaging', async () => {
    const { encodeDecodeResult, decodeDecodeResult } = await loadWire();
    for (const reason of ['flat', 'unreadable', 'no-poster', 'fetch-failed', 'host-not-allowed'] as const) {
      const back = decodeDecodeResult(viaJson(encodeDecodeResult({ status: 'skipped', reason })));
      expect(back).toEqual({ status: 'skipped', reason });
    }
  });
});
