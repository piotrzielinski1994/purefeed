import { describe, expect, it } from 'vitest';

const loadHamming = () => import('./hamming.ts');

describe('hamming distance (AC-023)', () => {
  it('should count set bits of a 32-bit word if popcount32 is called', async () => {
    const { popcount32 } = await loadHamming();
    expect(popcount32(0)).toBe(0);
    expect(popcount32(1)).toBe(1);
    expect(popcount32(0x80000000)).toBe(1);
    expect(popcount32(0x55555555)).toBe(16);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(-1)).toBe(32);
    expect(popcount32(0x0f0f00f1)).toBe(13);
  });

  it('should count differing bits across both words if 2 64-bit hashes are compared', async () => {
    const { hamming64 } = await loadHamming();
    expect(hamming64(Uint32Array.of(0, 0), 0, Uint32Array.of(0, 0), 0)).toBe(0);
    expect(hamming64(Uint32Array.of(0xffffffff, 0), 0, Uint32Array.of(0, 0), 0)).toBe(32);
    expect(hamming64(Uint32Array.of(1, 0x80000000), 0, Uint32Array.of(0, 0), 0)).toBe(2);
    expect(hamming64(Uint32Array.of(0xffffffff, 0xffffffff), 0, Uint32Array.of(0, 0), 0)).toBe(64);
    expect(hamming64(Uint32Array.of(0x12345678, 0x9abcdef0), 0, Uint32Array.of(0x12345678, 0x9abcdef0), 0)).toBe(0);
    expect(hamming64(Uint32Array.of(0b111, 0b1), 0, Uint32Array.of(0, 0), 0)).toBe(4);
  });

  it('should map Hamming distance 3, 4, 6, 7 of 64 bits to 95.3%, 93.8%, 90.6%, 89.1% if similarityFromDistance is called', async () => {
    const { similarityFromDistance } = await loadHamming();
    expect(similarityFromDistance(0)).toBe(100);
    expect(similarityFromDistance(3)).toBeCloseTo(95.3125, 6);
    expect(similarityFromDistance(4)).toBeCloseTo(93.75, 6);
    expect(similarityFromDistance(6)).toBeCloseTo(90.625, 6);
    expect(similarityFromDistance(7)).toBeCloseTo(89.0625, 6);
    expect(similarityFromDistance(64)).toBe(0);
  });

  it('should divide by the given bit count if bits is passed to similarityFromDistance', async () => {
    const { similarityFromDistance } = await loadHamming();
    expect(similarityFromDistance(1, 128)).toBeCloseTo(99.21875, 6);
    expect(similarityFromDistance(32, 128)).toBeCloseTo(75, 6);
  });
});
