import { describe, expect, it } from 'vitest';
import { IMAGE_ASSETS } from '../../scripts/generate-assets.ts';
import { loadGray } from '../../test/helpers/assets.ts';
import { createFakeClock } from '../../test/helpers/fake-ext.ts';
import { DEFAULT_THRESHOLDS, flip, type Hash, imageFpWithCropDeltas, randomHashes } from '../../test/helpers/fingerprints.ts';
import { fingerprintImage } from '../fingerprint/image-fingerprint.ts';
import type { Fingerprint } from '../shared/types.ts';
import type { SeenRecord } from './seen-record.ts';
import { createSeenRepository } from './seen-repository.ts';
import { createMemorySeenStore } from './seen-store.ts';

function recordOf(fingerprint: Fingerprint, firstSeenAt: number, lastSeenAt: number): SeenRecord {
  return {
    fingerprint,
    contentType: 'image',
    platform: 'wykop',
    firstSeenPostKey: 'wykop:entry:9',
    firstSeenPermalink: 'https://wykop.pl/wpis/9',
    firstSeenAt,
    lastSeenAt,
    seenCount: 4,
  };
}

async function setup(opts: { seed: Array<[string, SeenRecord]> }) {
  const clock = createFakeClock();
  const store = createMemorySeenStore();
  await store.write(opts.seed);
  let n = 0;
  const repo = createSeenRepository({ openStore: async () => store, now: clock.now, setTimer: clock.setTimer, newId: () => `id-${++n}` });
  return { repo };
}

describe('seen repository lookup performance (AC-078)', () => {
  it('should return 1 lookup in <= 50 ms at the 95th percentile if 50,000 records with real crop offsets are stored (TC-101)', async () => {
    const t = Date.UTC(2026, 10, 10);
    const cropDeltas = IMAGE_ASSETS.flatMap((name) => {
      const fp = fingerprintImage(loadGray(name));
      return fp ? [fp.crops.map((crop, i) => (crop ^ fp.hash[i % 2]) >>> 0)] : [];
    });
    const realistic = (h: Hash, i: number) => imageFpWithCropDeltas(h, cropDeltas[i % cropDeltas.length]);
    const hashes = randomHashes(50_000, 31337);
    const seed: Array<[string, SeenRecord]> = hashes.map((h, i) => [`r${i}`, recordOf(realistic(h, i), t, t)]);
    const { repo } = await setup({ seed });
    await repo.ready;
    const misses = randomHashes(900, 4242);
    const durations: number[] = [];
    let hits = 0;
    expect(cropDeltas.length).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 1000; i++) {
      const query = i % 10 === 0 ? realistic(flip(hashes[i * 49], 2), i + 1) : realistic(misses[i - Math.ceil(i / 10)], i);
      const started = performance.now();
      const match = repo.lookup(query, DEFAULT_THRESHOLDS);
      durations.push(performance.now() - started);
      if (i % 10 === 0) {
        expect(match?.id).toBe(`r${i * 49}`);
        hits++;
      } else {
        expect(match).toBeNull();
      }
    }
    durations.sort((a, b) => a - b);
    expect(hits).toBe(100);
    expect(durations[Math.ceil(0.95 * durations.length) - 1]).toBeLessThanOrEqual(50);
  }, 120_000);
});
