import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS, flip, imageFp, randomHashes } from '../../test/helpers/fingerprints.ts';

const calls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../similarity/compare.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../similarity/compare.ts')>();
  return {
    ...actual,
    compareFingerprints: (...args: Parameters<typeof actual.compareFingerprints>) => {
      calls.count++;
      return actual.compareFingerprints(...args);
    },
  };
});

const [HA, HB] = randomHashes(2, 7575);

describe('page session comparison cache (AC-075)', () => {
  it('should compare each ordered pair of fingerprint contents once per thresholds in a page session', async () => {
    const { createPageSession } = await import('./page-session.ts');
    const { compareFingerprints } = await import('../similarity/compare.ts');
    const session = createPageSession(() => 0);
    const seenA = imageFp(HA);
    const copyA = imageFp(flip(HA, 1));
    const other = imageFp(HB);
    session.addItem({ postKey: 'reddit:t3_1', platform: 'reddit', permalink: 'https://www.reddit.com/1', fingerprint: seenA });
    session.addItem({ postKey: 'reddit:t3_2', platform: 'reddit', permalink: 'https://www.reddit.com/2', fingerprint: other });
    calls.count = 0;
    const decide = () => session.findSessionMatch(imageFp(flip(HA, 1)), 'reddit:t3_3', () => true, DEFAULT_THRESHOLDS);
    const first = decide();
    expect(calls.count).toBe(2);
    expect([decide(), decide(), decide()]).toEqual([first, first, first]);
    expect(session.compare(copyA, seenA, DEFAULT_THRESHOLDS)).toEqual(compareFingerprints(copyA, seenA, DEFAULT_THRESHOLDS));
    expect(calls.count).toBe(3);
    expect(first).toMatchObject({ matchClass: 'exact', postKey: 'reddit:t3_1' });
    session.findSessionMatch(copyA, 'reddit:t3_3', () => true, { exact: 100, near: 90 });
    expect(calls.count).toBe(5);
    expect(session.compare(seenA, copyA, DEFAULT_THRESHOLDS).matchClass).toBe('exact');
    expect(calls.count).toBe(6);
  });
});
