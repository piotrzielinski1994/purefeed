import type { GrayImage } from '../shared/types.ts';
import { dctLowBand } from './dct.ts';
import { resizeArea } from './gray.ts';

const DCT_SIZE = 32;
const LOW_BAND = 8;
const WORD_BITS = 32;
const WINDOW_SIGMA = 0.18;

const axisWeight = (i: number): number => Math.exp(-(((i + 0.5) / DCT_SIZE - 0.5) ** 2) / (2 * WINDOW_SIGMA ** 2));
const WINDOW = Float64Array.from({ length: DCT_SIZE * DCT_SIZE }, (_, i) => axisWeight(i % DCT_SIZE) * axisWeight(Math.floor(i / DCT_SIZE)));

export function packBits(bits: readonly boolean[]): Uint32Array {
  const words = new Uint32Array(Math.ceil(bits.length / WORD_BITS));
  bits.forEach((isSet, i) => {
    if (isSet) words[i >>> 5] |= 1 << (i & 31);
  });
  return words;
}

export function pHash64(img: GrayImage): Uint32Array {
  const small = resizeArea(img, DCT_SIZE, DCT_SIZE);
  const coefficients = Array.from(
    dctLowBand(
      Float64Array.from(small.data, (v, i) => v * WINDOW[i]),
      DCT_SIZE,
      LOW_BAND,
    ),
  );
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) / 2];
  return packBits(coefficients.map((c) => c > median));
}
