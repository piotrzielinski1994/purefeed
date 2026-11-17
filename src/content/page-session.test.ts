import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, flip, imageFp, posterFp, randomHashes, sequenceFp } from '../../test/helpers/fingerprints.ts';

const loadSession = () => import('./page-session.ts');

const [HA, HB] = randomHashes(2, 4242);
const FRAMES = randomHashes(8, 99);
const T0 = Date.UTC(2026, 10, 17, 12);
const EARLY = 'reddit:t3_early';
const LATE = 'reddit:t3_late';
const EARLY_PERMALINK = 'https://www.reddit.com/r/memes/comments/early/x/';

async function sessionAt(times: number[]) {
  const { createPageSession } = await loadSession();
  let i = 0;
  return createPageSession(() => times[Math.min(i++, times.length - 1)]);
}

const precedesAll = () => true;

describe('createPageSession (AC-030, AC-033, AC-053, AC-061)', () => {
  it('should start with empty decisions, reveals, hidden counts, own records and URL results', async () => {
    const session = await sessionAt([T0]);
    expect(session.decisions.size).toBe(0);
    expect(session.revealed.size).toBe(0);
    expect(session.hiddenCounted.size).toBe(0);
    expect(session.ownRecordIds.size).toBe(0);
    expect(session.urlResults.size).toBe(0);
  });

  it('should return exact session evidence of an earlier post with the same media (TC-046)', async () => {
    const session = await sessionAt([T0 + 10]);
    session.addItem({ postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, fingerprint: imageFp(HA) });
    const evidence = session.findSessionMatch(imageFp(flip(HA, 1)), LATE, precedesAll, DEFAULT_THRESHOLDS);
    expect(evidence).toEqual({ matchClass: 'exact', postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, at: T0 + 10 });
  });

  it('should return near session evidence for a near copy', async () => {
    const session = await sessionAt([T0]);
    session.addItem({ postKey: EARLY, platform: 'wykop', permalink: 'https://wykop.pl/wpis/1', fingerprint: imageFp(HA) });
    const evidence = session.findSessionMatch(imageFp(flip(HA, 5)), LATE, precedesAll, DEFAULT_THRESHOLDS);
    expect(evidence).toMatchObject({ matchClass: 'near', postKey: EARLY, platform: 'wykop' });
  });

  it('should never match a post against its own items (TC-042)', async () => {
    const session = await sessionAt([T0]);
    session.addItem({ postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, fingerprint: imageFp(HA) });
    expect(session.findSessionMatch(imageFp(HA), EARLY, precedesAll, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should ignore items of posts that do not precede the post in document order', async () => {
    const session = await sessionAt([T0]);
    session.addItem({
      postKey: LATE,
      platform: 'reddit',
      permalink: 'https://www.reddit.com/r/memes/comments/late/x/',
      fingerprint: imageFp(HA),
    });
    const precedes = (other: string) => other !== LATE;
    expect(session.findSessionMatch(imageFp(HA), EARLY, precedes, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should return no evidence for different media', async () => {
    const session = await sessionAt([T0]);
    session.addItem({ postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, fingerprint: imageFp(HA) });
    expect(session.findSessionMatch(imageFp(HB), LATE, precedesAll, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should compare only fingerprints of the same kind', async () => {
    const session = await sessionAt([T0]);
    session.addItem({ postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, fingerprint: imageFp(FRAMES[0]) });
    session.addItem({ postKey: EARLY, platform: 'reddit', permalink: EARLY_PERMALINK, fingerprint: posterFp(HA) });
    expect(session.findSessionMatch(sequenceFp(FRAMES, 20), LATE, precedesAll, DEFAULT_THRESHOLDS)).toBeNull();
    expect(session.findSessionMatch(imageFp(HA), LATE, precedesAll, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('should match frame sequences of an earlier video post', async () => {
    const session = await sessionAt([T0 + 3]);
    session.addItem({ postKey: EARLY, platform: 'x', permalink: 'https://x.com/a/status/1', fingerprint: sequenceFp(FRAMES, 20) });
    const evidence = session.findSessionMatch(sequenceFp(FRAMES, 20), LATE, precedesAll, DEFAULT_THRESHOLDS);
    expect(evidence).toEqual({ matchClass: 'exact', postKey: EARLY, platform: 'x', permalink: 'https://x.com/a/status/1', at: T0 + 3 });
  });
});
