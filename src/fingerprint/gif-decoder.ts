import type { FrameSequenceFingerprint, ImageFingerprint } from '../shared/types.ts';
import { fingerprintSequence, sampleTimestamps } from './frame-sequence.ts';
import { rgbaToGray } from './gray.ts';
import { fingerprintImage } from './image-fingerprint.ts';

export type DecodedGif = { width: number; height: number; frames: Array<{ rgba: Uint8ClampedArray; delayMs: number }> };

type Control = { disposal: number; delayMs: number; transparentIndex: number | null };
type Cursor = { pos: number };

const EXTENSION = 0x21;
const IMAGE = 0x2c;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL = 0xf9;
const MAX_CODE_BITS = 12;
const MAX_CODES = 1 << MAX_CODE_BITS;
const OPAQUE = 255;
const DISPOSE_BACKGROUND = 2;
const DISPOSE_PREVIOUS = 3;
const MIN_BROWSER_DELAY_MS = 10;
const BROWSER_DEFAULT_DELAY_MS = 100;
const MAX_SEQUENCE_FRAMES = 8;
const MS_PER_S = 1000;
const CS_TO_MS = 10;
const NO_CONTROL: Control = { disposal: 0, delayMs: 0, transparentIndex: null };
const INTERLACE_PASSES = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
] as const;

const u16 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8);

function readTable(bytes: Uint8Array, cursor: Cursor, packed: number): Uint8Array | null {
  if ((packed & 0x80) === 0) {
    return null;
  }
  const length = 3 * (1 << ((packed & 0x07) + 1));
  const table = bytes.subarray(cursor.pos, cursor.pos + length);
  cursor.pos += length;
  return table;
}

function readSubBlocks(bytes: Uint8Array, cursor: Cursor): Uint8Array {
  const chunks: Uint8Array[] = [];
  while (cursor.pos < bytes.length && bytes[cursor.pos] !== 0) {
    const size = bytes[cursor.pos];
    chunks.push(bytes.subarray(cursor.pos + 1, cursor.pos + 1 + size));
    cursor.pos += size + 1;
  }
  cursor.pos += 1;
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  chunks.reduce((offset, c) => {
    out.set(c, offset);
    return offset + c.length;
  }, 0);
  return out;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const prefix = new Int16Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const firstByte = new Uint8Array(MAX_CODES);
  const lengths = new Uint16Array(MAX_CODES);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  for (let c = 0; c < clear; c++) {
    suffix[c] = c;
    firstByte[c] = c;
    lengths[c] = 1;
  }
  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let prev = -1;
  let written = 0;
  let bitPos = 0;
  const totalBits = data.length * 8;
  while (written < pixelCount && bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let b = 0; b < codeSize; b++, bitPos++) code |= ((data[bitPos >>> 3] >>> (bitPos & 7)) & 1) << b;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      prev = -1;
      continue;
    }
    if (code === end) {
      break;
    }
    if (prev === -1) {
      out[written++] = suffix[code];
      prev = code;
      continue;
    }
    const isKnown = code < next;
    const head = isKnown ? firstByte[code] : firstByte[prev];
    if (next < MAX_CODES) {
      prefix[next] = prev;
      suffix[next] = head;
      firstByte[next] = firstByte[prev];
      lengths[next] = lengths[prev] + 1;
      next++;
      if (next === 1 << codeSize && codeSize < MAX_CODE_BITS) codeSize++;
    }
    const emit = isKnown ? code : next - 1;
    const length = lengths[emit];
    for (let j = length - 1, k = emit; j >= 0; j--, k = prefix[k]) {
      if (written + j < pixelCount) out[written + j] = suffix[k];
    }
    written += length;
    prev = code;
  }
  return out;
}

const interlacedRows = (height: number): number[] =>
  INTERLACE_PASSES.flatMap(([start, step]) =>
    Array.from({ length: Math.max(0, Math.ceil((height - start) / step)) }, (_, k) => start + k * step),
  );

function readControl(bytes: Uint8Array, cursor: Cursor): Control {
  const block = readSubBlocks(bytes, cursor);
  const packed = block[0];
  return {
    disposal: (packed >>> 2) & 0x07,
    delayMs: u16(block, 1) * CS_TO_MS,
    transparentIndex: (packed & 0x01) === 1 ? block[3] : null,
  };
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new Error('Not a GIF file');
  }
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  const cursor: Cursor = { pos: 13 };
  const globalTable = readTable(bytes, cursor, bytes[10]);
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: DecodedGif['frames'] = [];
  let control = NO_CONTROL;
  while (cursor.pos < bytes.length && bytes[cursor.pos] !== TRAILER) {
    const introducer = bytes[cursor.pos++];
    if (introducer === EXTENSION) {
      const label = bytes[cursor.pos++];
      if (label === GRAPHIC_CONTROL) {
        control = readControl(bytes, cursor);
      } else {
        readSubBlocks(bytes, cursor);
      }
      continue;
    }
    if (introducer !== IMAGE) {
      break;
    }
    const left = u16(bytes, cursor.pos);
    const top = u16(bytes, cursor.pos + 2);
    const w = u16(bytes, cursor.pos + 4);
    const h = u16(bytes, cursor.pos + 6);
    const packed = bytes[cursor.pos + 8];
    cursor.pos += 9;
    const table = readTable(bytes, cursor, packed) ?? globalTable ?? new Uint8Array(0);
    const minCodeSize = bytes[cursor.pos++];
    const indices = lzwDecode(readSubBlocks(bytes, cursor), minCodeSize, w * h);
    const rows = (packed & 0x40) !== 0 ? interlacedRows(h) : null;
    const saved = control.disposal === DISPOSE_PREVIOUS ? canvas.slice() : null;
    indices.forEach((index, i) => {
      const x = left + (i % w);
      const y = top + (rows?.[Math.floor(i / w)] ?? Math.floor(i / w));
      if (index === control.transparentIndex || x >= width || y >= height || 3 * index + 2 >= table.length) {
        return;
      }
      const p = (y * width + x) * 4;
      canvas[p] = table[3 * index];
      canvas[p + 1] = table[3 * index + 1];
      canvas[p + 2] = table[3 * index + 2];
      canvas[p + 3] = OPAQUE;
    });
    frames.push({ rgba: canvas.slice(), delayMs: control.delayMs });
    if (control.disposal === DISPOSE_BACKGROUND) {
      Array.from({ length: h }, (_, row) => top + row)
        .filter((y) => y < height)
        .forEach((y) => {
          canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
        });
    }
    if (saved) {
      canvas.set(saved);
    }
    control = NO_CONTROL;
  }
  return { width, height, frames };
}

const browserDelayMs = (delayMs: number): number => (delayMs <= MIN_BROWSER_DELAY_MS ? BROWSER_DEFAULT_DELAY_MS : delayMs);

const isSameFrame = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => a.every((v, i) => v === b[i]);

export function fingerprintGif(gif: DecodedGif): ImageFingerprint | FrameSequenceFingerprint | null {
  if (gif.frames.length === 0) {
    return null;
  }
  const toGray = (rgba: Uint8ClampedArray) => rgbaToGray(rgba, gif.width, gif.height);
  if (gif.frames.length === 1) {
    return fingerprintImage(toGray(gif.frames[0].rgba));
  }
  const starts = gif.frames.reduce<number[]>(
    (acc, f) => {
      acc.push(acc[acc.length - 1] + browserDelayMs(f.delayMs) / MS_PER_S);
      return acc;
    },
    [0],
  );
  const durationS = starts[starts.length - 1];
  const runs = gif.frames
    .map((frame, i) => ({ frame, tS: starts[i] }))
    .filter((run, i, all) => i === 0 || !isSameFrame(run.frame.rgba, all[i - 1].frame.rgba));
  const picked =
    runs.length <= MAX_SEQUENCE_FRAMES
      ? runs
      : sampleTimestamps(durationS, MAX_SEQUENCE_FRAMES).map((tS) => ({ frame: gif.frames[starts.findLastIndex((s) => s <= tS)], tS }));
  return fingerprintSequence(
    picked.map(({ frame, tS }) => ({ tS, image: toGray(frame.rgba) })),
    durationS,
  );
}
