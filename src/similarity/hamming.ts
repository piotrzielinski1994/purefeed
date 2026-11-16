export const HASH_BITS = 64;

export function popcount32(x: number): number {
  const pairs = x - ((x >>> 1) & 0x55555555);
  const nibbles = (pairs & 0x33333333) + ((pairs >>> 2) & 0x33333333);
  return (Math.imul((nibbles + (nibbles >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

export const hamming64 = (a: Uint32Array, ai: number, b: Uint32Array, bi: number): number =>
  popcount32(a[ai] ^ b[bi]) + popcount32(a[ai + 1] ^ b[bi + 1]);

export const similarityFromDistance = (d: number, bits = HASH_BITS): number => 100 * (1 - d / bits);
