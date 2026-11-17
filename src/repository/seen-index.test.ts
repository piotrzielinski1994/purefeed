import { describe, expect, it } from 'vitest';
import { CROP_WORDS, DEFAULT_THRESHOLDS, flip, imageFp, posterFp, randomHashes, sequenceFp } from '../../test/helpers/fingerprints.ts';
import { CROP_VARIANTS } from '../fingerprint/crops.ts';
import type { Fingerprint, ImageFingerprint, MatchClass, Thresholds } from '../shared/types.ts';
import { compareFingerprints } from '../similarity/compare.ts';
import type { SeenRecord } from './seen-record.ts';

const loadIndex = () => import('./seen-index.ts');

const T0 = Date.UTC(2026, 10, 1);
const [A, B, C] = randomHashes(3, 101);
const FRAMES = randomHashes(8, 55);

function recordOf(fingerprint: Fingerprint, lastSeenAt = T0): SeenRecord {
  return {
    fingerprint,
    contentType: fingerprint.kind === 'image' ? 'image' : 'video',
    platform: 'x',
    firstSeenPostKey: 'x:1',
    firstSeenPermalink: 'https://x.com/a/status/1',
    firstSeenAt: T0,
    lastSeenAt,
    seenCount: 1,
  };
}

describe('seen index', () => {
  it('should return the best match with its record and comparison if 2 records match the query', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('near', recordOf(imageFp(flip(A, 5))));
    index.upsert('exact', recordOf(imageFp(flip(A, 1))));
    index.upsert('other', recordOf(imageFp(B)));
    const match = index.findBest(imageFp(A), DEFAULT_THRESHOLDS);
    expect(match?.id).toBe('exact');
    expect(match?.comparison.matchClass).toBe('exact');
    expect(match?.record.firstSeenPostKey).toBe('x:1');
  });

  it('should return a near match if only a near record exists and null if nothing matches', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('near', recordOf(imageFp(flip(A, 5))));
    expect(index.findBest(imageFp(A), DEFAULT_THRESHOLDS)).toMatchObject({ id: 'near', comparison: { matchClass: 'near' } });
    expect(index.findBest(imageFp(C), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should apply the given thresholds if they differ from the defaults', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('r', recordOf(imageFp(flip(A, 1))));
    expect(index.findBest(imageFp(A), { exact: 100, near: 90 })?.comparison.matchClass).toBe('near');
    expect(index.findBest(imageFp(A), { exact: 100, near: 99 })).toBeNull();
  });

  it('should match sequences with sequences and posters with posters but never an image with a frame (AC-025)', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('seq', recordOf(sequenceFp(FRAMES, 20)));
    index.upsert('poster', recordOf(posterFp(B)));
    expect(index.findBest(sequenceFp(FRAMES, 20), DEFAULT_THRESHOLDS)?.id).toBe('seq');
    expect(index.findBest(posterFp(B), DEFAULT_THRESHOLDS)?.id).toBe('poster');
    expect(index.findBest(imageFp(FRAMES[0]), DEFAULT_THRESHOLDS)).toBeNull();
    expect(index.findBest(imageFp(B), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should keep 1 entry with the new values if upsert runs twice for the same id', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('r', recordOf(imageFp(A), T0));
    index.upsert('r', { ...recordOf(imageFp(A), T0 + 10_000), seenCount: 2 });
    expect(index.size).toBe(1);
    expect(index.findBest(imageFp(A), DEFAULT_THRESHOLDS)?.record.seenCount).toBe(2);
    expect(index.idsLastSeenBefore(T0 + 1)).toEqual([]);
  });

  it('should stop matching removed ids and hold 0 entries after clear', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('a', recordOf(imageFp(A)));
    index.upsert('b', recordOf(imageFp(B)));
    index.remove(['a']);
    expect(index.size).toBe(1);
    expect(index.findBest(imageFp(A), DEFAULT_THRESHOLDS)).toBeNull();
    expect(index.findBest(imageFp(B), DEFAULT_THRESHOLDS)?.id).toBe('b');
    index.clear();
    expect(index.size).toBe(0);
    expect(index.findBest(imageFp(B), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should list only ids with last seen strictly before the cutoff', async () => {
    const { SeenIndex } = await loadIndex();
    const index = new SeenIndex();
    index.upsert('old', recordOf(imageFp(A), T0 - 1));
    index.upsert('edge', recordOf(imageFp(B), T0));
    index.upsert('new', recordOf(imageFp(C), T0 + 1));
    expect(index.idsLastSeenBefore(T0)).toEqual(['old']);
  });
});

describe('seen index crop alignment pruning (AC-011, AC-078)', () => {
  const RANK: Record<MatchClass, number> = { exact: 2, near: 1, different: 0 };
  const words = randomHashes(4000, 77).flat();
  const takeWords = (from: number, count: number) => Uint32Array.from(words.slice(from, from + count));
  const withParts = (hash: Uint32Array, crops: Uint32Array): ImageFingerprint => ({ ...imageFp([hash[0], hash[1]]), hash, crops });
  const queries = randomHashes(20, 909).map((h, q) => withParts(Uint32Array.of(...h), takeWords(q * CROP_WORDS, CROP_WORDS)));
  const plantedRecordCrop = queries.map((q, i) => {
    const crops = takeWords(1000 + i * CROP_WORDS, CROP_WORDS);
    crops.set(Uint32Array.of(...flip([q.hash[0], q.hash[1]], 3)), 2 * (i % CROP_VARIANTS.length));
    return withParts(takeWords(3000 + i * 2, 2), crops);
  });
  const plantedQueryCrop = queries.map((q, i) => {
    const j = (i * 7) % CROP_VARIANTS.length;
    return withParts(Uint32Array.of(...flip([q.crops[2 * j], q.crops[2 * j + 1]], 4)), takeWords(2000 + i * CROP_WORDS, CROP_WORDS));
  });
  const noise = randomHashes(500, 4321).map((h, i) => withParts(Uint32Array.of(...h), takeWords((i * 8) % 3900, CROP_WORDS)));

  const bruteForce = (q: ImageFingerprint, fps: ImageFingerprint[], t: Thresholds) =>
    fps
      .map((fp) => compareFingerprints(q, fp, t))
      .filter((c) => c.matchClass !== 'different')
      .reduce<{ matchClass: MatchClass; similarity: number } | null>(
        (best, c) =>
          best === null || RANK[c.matchClass] > RANK[best.matchClass] || (c.matchClass === best.matchClass && c.similarity > best.similarity)
            ? { matchClass: c.matchClass, similarity: c.similarity }
            : best,
        null,
      );

  it.each([DEFAULT_THRESHOLDS, { exact: 95, near: 80 }])(
    'should find the same best match as a full scan if crops align in either direction (near %o)',
    async (t) => {
      const { SeenIndex } = await loadIndex();
      const index = new SeenIndex();
      const all = [...plantedRecordCrop, ...plantedQueryCrop, ...noise];
      all.forEach((fp, i) => {
        index.upsert(`r${i}`, recordOf(fp));
      });
      const found = queries.map((q) => {
        const match = index.findBest(q, t);
        return match && { matchClass: match.comparison.matchClass, similarity: match.comparison.similarity };
      });
      expect(found).toEqual(queries.map((q) => bruteForce(q, all, t)));
      expect(found.every((m) => m !== null)).toBe(true);
    },
  );
});
