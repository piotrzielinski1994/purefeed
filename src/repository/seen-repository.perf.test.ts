import { describe, expect, it } from 'vitest';
import { IMAGE_ASSETS } from '../../scripts/generate-assets.ts';
import { loadGray } from '../../test/helpers/assets.ts';
import { createFakeClock } from '../../test/helpers/fake-ext.ts';
import {
  DEFAULT_THRESHOLDS,
  flip,
  type Hash,
  imageFpWithCropDeltas,
  posterFp,
  randomHashes,
  sequenceFp,
} from '../../test/helpers/fingerprints.ts';
import { fingerprintImage } from '../fingerprint/image-fingerprint.ts';
import type { Fingerprint } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';
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

describe('seen repository lookup performance with a mixed store (AC-078)', () => {
  it('should return 1 lookup in <= 50 ms at the 95th percentile if 50,000 image, video and poster records with real edge maps are stored', async () => {
    const t = Date.UTC(2026, 10, 10);
    const assets = IMAGE_ASSETS.flatMap((name) => {
      const fp = fingerprintImage(loadGray(name));
      return fp ? [{ cropDeltas: fp.crops.map((crop, i) => (crop ^ fp.hash[i % 2]) >>> 0), edges: fp.edges }] : [];
    });
    const realImage = (h: Hash, a: number): Fingerprint => ({ ...imageFpWithCropDeltas(h, assets[a].cropDeltas), edges: assets[a].edges });
    const IMAGES = 45_000;
    const VIDEOS = 4_000;
    const POSTERS = 1_000;
    const hashes = randomHashes(IMAGES + VIDEOS * 8 + POSTERS, 2718);
    const videoFrames = (v: number) => hashes.slice(IMAGES + v * 8, IMAGES + (v + 1) * 8);
    const imageSeed = hashes.slice(0, IMAGES).map((h, i): [string, SeenRecord] => [`i${i}`, recordOf(realImage(h, i % assets.length), t, t)]);
    const videoSeed = Array.from({ length: VIDEOS }, (_, v): [string, SeenRecord] => [
      `v${v}`,
      { ...recordOf(sequenceFp(videoFrames(v), 20), t, t), contentType: 'video' },
    ]);
    const posterSeed = hashes
      .slice(IMAGES + VIDEOS * 8)
      .map((h, p): [string, SeenRecord] => [`p${p}`, { ...recordOf(posterFp(h), t, t), contentType: 'video' }]);
    const { repo } = await setup({ seed: [...imageSeed, ...videoSeed, ...posterSeed] });
    await repo.ready;
    expect(assets.length).toBeGreaterThanOrEqual(20);
    expect(new Set(assets.map((a) => Array.from(a.edges).join())).size).toBeGreaterThanOrEqual(20);
    const misses = randomHashes(1000, 1618);
    type Probe = { query: Fingerprint; expected: string | null };
    const probes = Array.from({ length: 1000 }, (_, i): Probe => {
      const image = (i * 37) % IMAGES;
      const video = (i * 13) % VIDEOS;
      switch (i % 10) {
        case 0:
          return { query: realImage(flip(hashes[image], 2), image % assets.length), expected: `i${image}` };
        case 1: {
          const query = realImage(flip(hashes[image], 2), (image + 1) % assets.length);
          const isSamePicture = compareFingerprints(query, imageSeed[image][1].fingerprint, DEFAULT_THRESHOLDS).matchClass !== 'different';
          return { query, expected: isSamePicture ? `i${image}` : null };
        }
        case 2:
          return {
            query: sequenceFp(
              videoFrames(video).map((h) => flip(h, 1)),
              20,
            ),
            expected: `v${video}`,
          };
        case 3:
          return { query: sequenceFp(randomHashes(8, 9000 + i), 20), expected: null };
        case 4:
          return { query: posterFp(misses[i]), expected: null };
        default:
          return { query: realImage(misses[i], i % assets.length), expected: null };
      }
    });
    const durations = probes.map(({ query, expected }) => {
      const started = performance.now();
      const match = repo.lookup(query, DEFAULT_THRESHOLDS);
      const ms = performance.now() - started;
      expect(match?.id ?? null).toBe(expected);
      return ms;
    });
    durations.sort((a, b) => a - b);
    expect(durations[Math.ceil(0.95 * durations.length) - 1]).toBeLessThanOrEqual(50);
  }, 180_000);
});
