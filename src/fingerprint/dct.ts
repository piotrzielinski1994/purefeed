export function dctLowBand(values: Float64Array, size: number, band: number): Float64Array {
  const basis = Float64Array.from({ length: band * size }, (_, i) => {
    const u = Math.floor(i / size);
    const scale = Math.sqrt((u === 0 ? 1 : 2) / size);
    return scale * Math.cos(((2 * (i % size) + 1) * u * Math.PI) / (2 * size));
  });
  const rows = Float64Array.from({ length: size * band }, (_, i) => {
    const y = Math.floor(i / band);
    const u = i % band;
    return values.subarray(y * size, (y + 1) * size).reduce((sum, v, x) => sum + v * basis[u * size + x], 0);
  });
  return Float64Array.from({ length: band * band }, (_, i) => {
    const v = Math.floor(i / band);
    const u = i % band;
    return Array.from({ length: size }, (_, y) => rows[y * band + u] * basis[v * size + y]).reduce((sum, p) => sum + p, 0);
  });
}
