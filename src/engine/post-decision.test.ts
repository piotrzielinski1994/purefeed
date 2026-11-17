import { describe, expect, it } from 'vitest';
import { loadGray } from '../../test/helpers/assets.ts';
import { DAY_MS } from '../../test/helpers/fingerprints.ts';
import { fingerprintImage } from '../fingerprint/image-fingerprint.ts';
import { SeenIndex } from '../repository/seen-index.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import type { ContentType, Platform, SeenMatch, Settings } from '../shared/types.ts';
import type { ItemEvidence, SessionEvidence } from './post-decision.ts';

const loadDecision = () => import('./post-decision.ts');

const NOW = Date.UTC(2026, 10, 17, 12);
const POST = 'reddit:t3_p1';
const AUTHOR = 'reddit:u/alice';
const SUBREDDIT = 'reddit:r/memes';

const seen = (matchClass: 'exact' | 'near', overrides: Partial<SeenMatch> = {}): SeenMatch => ({
  recordId: 'rec-1',
  matchClass,
  platform: 'reddit',
  firstSeenPostKey: 'reddit:t3_old',
  firstSeenPermalink: 'https://www.reddit.com/r/memes/comments/old/x/',
  firstSeenAt: NOW - DAY_MS,
  ...overrides,
});

const session = (matchClass: 'exact' | 'near', overrides: Partial<SessionEvidence> = {}): SessionEvidence => ({
  matchClass,
  postKey: 'reddit:t3_earlier',
  platform: 'reddit',
  permalink: 'https://www.reddit.com/r/memes/comments/earlier/x/',
  at: NOW - 1000,
  ...overrides,
});

const item = (contentType: ContentType, evidence: Partial<Omit<ItemEvidence, 'contentType'>> = {}): ItemEvidence => ({
  contentType,
  seen: null,
  session: null,
  ...evidence,
});

type Overrides = Partial<{
  postKey: string;
  platform: Platform;
  sourceKeys: string[];
  isFocal: boolean;
  revealed: boolean;
  items: ItemEvidence[];
  settings: Settings;
  whitelist: string[];
  ownRecordIds: string[];
}>;

async function decide(o: Overrides = {}) {
  const { decidePost } = await loadDecision();
  const whitelist = new Set(o.whitelist ?? []);
  return decidePost({
    postKey: o.postKey ?? POST,
    platform: o.platform ?? 'reddit',
    sourceKeys: o.sourceKeys ?? [AUTHOR, SUBREDDIT],
    isFocal: o.isFocal ?? false,
    revealed: o.revealed ?? false,
    items: o.items ?? [item('image', { seen: seen('exact') })],
    settings: o.settings ?? DEFAULT_SETTINGS,
    isWhitelisted: (key) => whitelist.has(key),
    ownRecordIds: new Set(o.ownRecordIds ?? []),
  });
}

const EXACT_ONLY: Settings = { ...DEFAULT_SETTINGS, mode: 'exact' };

describe('decidePost mode (AC-026)', () => {
  it('should hide a post with an exact match if mode is exact only (TC-036)', async () => {
    const decision = await decide({ settings: EXACT_ONLY, items: [item('image', { seen: seen('exact') })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'reddit',
      firstSeenAt: NOW - DAY_MS,
      permalink: 'https://www.reddit.com/r/memes/comments/old/x/',
    });
  });

  it('should keep a post with only a near match visible if mode is exact only (TC-036)', async () => {
    const decision = await decide({ settings: EXACT_ONLY, items: [item('image', { seen: seen('near') })] });
    expect(decision).toEqual({ hide: false, reason: 'unique' });
  });

  it('should hide posts with exact and with near matches if mode is exact and near (TC-037)', async () => {
    const exact = await decide({ items: [item('image', { seen: seen('exact') })] });
    const near = await decide({ items: [item('image', { seen: seen('near') })] });
    expect(exact).toMatchObject({ hide: true, matchClass: 'exact' });
    expect(near).toMatchObject({ hide: true, matchClass: 'near' });
  });

  it('should keep a post with near session evidence visible if mode is exact only', async () => {
    const decision = await decide({ settings: EXACT_ONLY, items: [item('image', { session: session('near') })] });
    expect(decision).toEqual({ hide: false, reason: 'unique' });
  });
});

describe('decidePost mode on generated assets (AC-026, TC-036, TC-037)', () => {
  const SEEN_POST = { firstSeenPostKey: 'wykop:entry:5', firstSeenPermalink: 'https://wykop.pl/wpis/5', firstSeenAt: NOW - DAY_MS };

  async function hiddenCopies(settings: Settings): Promise<Record<string, boolean>> {
    const fingerprintOf = (name: string) => {
      const fp = fingerprintImage(loadGray(name));
      if (!fp) throw new Error(`${name}: no fingerprint`);
      return fp;
    };
    const index = new SeenIndex();
    index.upsert('rec-a', {
      ...SEEN_POST,
      fingerprint: fingerprintOf('base.png'),
      contentType: 'image',
      platform: 'wykop',
      lastSeenAt: NOW,
      seenCount: 1,
    });
    const thresholds = { exact: settings.exactThreshold, near: settings.nearThreshold };
    const decisions = await Promise.all(
      ['base-50.png', 'crop-r7.png'].map(async (name) => {
        const match = index.findBest(fingerprintOf(name), thresholds);
        const matchClass = match?.comparison.matchClass;
        const evidence = matchClass === 'exact' || matchClass === 'near' ? seen(matchClass, { ...SEEN_POST, platform: 'wykop' }) : null;
        return [name, (await decide({ settings, items: [item('image', { seen: evidence })] })).hide] as const;
      }),
    );
    return Object.fromEntries(decisions);
  }

  it('should hide only the resized copy if mode is exact only and the cropped copy is near (TC-036)', async () => {
    expect(await hiddenCopies(EXACT_ONLY)).toEqual({ 'base-50.png': true, 'crop-r7.png': false });
  });

  it('should hide the resized and the cropped copy if mode is exact and near (TC-037)', async () => {
    expect(await hiddenCopies(DEFAULT_SETTINGS)).toEqual({ 'base-50.png': true, 'crop-r7.png': true });
  });
});

describe('decidePost cross-platform evidence (AC-029)', () => {
  it('should name the platform and permalink of the first sighting if it was on another platform (TC-041)', async () => {
    const wykop = seen('exact', { platform: 'wykop', firstSeenPostKey: 'wykop:entry:77', firstSeenPermalink: 'https://wykop.pl/wpis/77' });
    const decision = await decide({ platform: 'reddit', items: [item('image', { seen: wykop })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'wykop',
      firstSeenAt: NOW - DAY_MS,
      permalink: 'https://wykop.pl/wpis/77',
    });
  });

  it('should hide an X post by a near match first seen on Wykop (TC-041)', async () => {
    const wykop = seen('near', { platform: 'wykop', firstSeenPermalink: 'https://wykop.pl/wpis/77', firstSeenAt: NOW - 2 * DAY_MS });
    const decision = await decide({ postKey: 'x:1999', platform: 'x', sourceKeys: ['x:@bob'], items: [item('image', { seen: wykop })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'near',
      platform: 'wykop',
      firstSeenAt: NOW - 2 * DAY_MS,
      permalink: 'https://wykop.pl/wpis/77',
    });
  });
});

describe('decidePost own sightings (AC-030)', () => {
  it('should keep a post visible if its only evidence is a record of this page session (TC-042)', async () => {
    const decision = await decide({ items: [item('image', { seen: seen('exact', { recordId: 'own-1' }) })], ownRecordIds: ['own-1'] });
    expect(decision).toEqual({ hide: false, reason: 'unique' });
  });

  it('should hide the same post if the record comes from an earlier page session (TC-043)', async () => {
    const decision = await decide({ items: [item('image', { seen: seen('exact', { recordId: 'own-1' }) })], ownRecordIds: [] });
    expect(decision).toMatchObject({ hide: true, matchClass: 'exact' });
  });

  it('should still use session evidence of an earlier post if the seen record is ignored as own', async () => {
    const decision = await decide({
      items: [item('image', { seen: seen('exact', { recordId: 'own-1' }), session: session('exact') })],
      ownRecordIds: ['own-1'],
    });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'reddit',
      firstSeenAt: NOW - 1000,
      permalink: 'https://www.reddit.com/r/memes/comments/earlier/x/',
    });
  });
});

describe('decidePost focal post (AC-031)', () => {
  it('should never hide the focal post on its own permalink page (TC-044 unit)', async () => {
    const decision = await decide({ isFocal: true, items: [item('image', { seen: seen('exact') })] });
    expect(decision).toEqual({ hide: false, reason: 'focal' });
  });
});

describe('decidePost session evidence (AC-033)', () => {
  it('should hide a later post by session evidence of an earlier post if nothing is recorded yet (TC-046)', async () => {
    const evidence = session('exact', { platform: 'reddit', at: NOW - 5000 });
    const decision = await decide({ items: [item('image', { session: evidence })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'reddit',
      firstSeenAt: NOW - 5000,
      permalink: 'https://www.reddit.com/r/memes/comments/earlier/x/',
    });
  });
});

describe('decidePost multi-media posts (AC-034)', () => {
  it('should keep a gallery visible if only one of its media items matches (TC-047)', async () => {
    const decision = await decide({ items: [item('image', { seen: seen('exact') }), item('image')] });
    expect(decision).toEqual({ hide: false, reason: 'unique' });
  });

  it('should hide a gallery if every media item matches (TC-048)', async () => {
    const decision = await decide({
      items: [item('image', { seen: seen('exact', { recordId: 'a' }) }), item('image', { seen: seen('exact', { recordId: 'd' }) })],
    });
    expect(decision).toMatchObject({ hide: true });
  });

  it('should never hide a post without fingerprinted media (TC-048)', async () => {
    const decision = await decide({ items: [] });
    expect(decision).toEqual({ hide: false, reason: 'no-media' });
  });

  it('should report the strongest item: exact over near', async () => {
    const near = seen('near', { recordId: 'n', platform: 'x', firstSeenPermalink: 'https://x.com/a/status/1', firstSeenAt: NOW - 9 * DAY_MS });
    const exact = seen('exact', { recordId: 'e', platform: 'wykop', firstSeenPermalink: 'https://wykop.pl/wpis/2', firstSeenAt: NOW - DAY_MS });
    const decision = await decide({ items: [item('image', { seen: near }), item('image', { seen: exact })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'wykop',
      firstSeenAt: NOW - DAY_MS,
      permalink: 'https://wykop.pl/wpis/2',
    });
  });

  it('should report the earliest first sighting among equally strong items', async () => {
    const later = seen('exact', { recordId: 'l', platform: 'x', firstSeenPermalink: 'https://x.com/a/status/1', firstSeenAt: NOW - DAY_MS });
    const earlier = seen('exact', {
      recordId: 'e',
      platform: 'wykop',
      firstSeenPermalink: 'https://wykop.pl/wpis/2',
      firstSeenAt: NOW - 3 * DAY_MS,
    });
    const decision = await decide({ items: [item('image', { seen: later }), item('image', { seen: earlier })] });
    expect(decision).toEqual({
      hide: true,
      matchClass: 'exact',
      platform: 'wykop',
      firstSeenAt: NOW - 3 * DAY_MS,
      permalink: 'https://wykop.pl/wpis/2',
    });
  });
});

describe('decidePost reveal and whitelist (AC-053, AC-054, AC-055)', () => {
  it('should keep a revealed post visible for the page session (TC-072 rule)', async () => {
    const decision = await decide({ revealed: true });
    expect(decision).toEqual({ hide: false, reason: 'revealed' });
  });

  it('should keep a whitelisted post key visible (TC-073 rule)', async () => {
    const decision = await decide({ whitelist: [POST] });
    expect(decision).toEqual({ hide: false, reason: 'whitelisted' });
  });

  it('should keep a post of a whitelisted author visible (TC-074 rule)', async () => {
    const decision = await decide({ whitelist: [AUTHOR] });
    expect(decision).toEqual({ hide: false, reason: 'whitelisted' });
  });

  it('should keep a post of a whitelisted subreddit visible', async () => {
    const decision = await decide({ whitelist: [SUBREDDIT] });
    expect(decision).toEqual({ hide: false, reason: 'whitelisted' });
  });

  it('should rank whitelisted before focal and revealed', async () => {
    const decision = await decide({ whitelist: [POST], isFocal: true, revealed: true });
    expect(decision).toEqual({ hide: false, reason: 'whitelisted' });
  });
});

describe('decidePost settings gates (AC-066)', () => {
  it('should not hide anything if deduplication is off', async () => {
    const decision = await decide({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
    expect(decision).toEqual({ hide: false, reason: 'disabled' });
  });

  it('should not hide a post if its platform toggle is off', async () => {
    const decision = await decide({ platform: 'wykop', settings: { ...DEFAULT_SETTINGS, platforms: { reddit: true, wykop: false, x: true } } });
    expect(decision).toEqual({ hide: false, reason: 'disabled' });
  });

  it('should rank disabled before no-media and whitelisted', async () => {
    const decision = await decide({ items: [], whitelist: [POST], settings: { ...DEFAULT_SETTINGS, enabled: false } });
    expect(decision).toEqual({ hide: false, reason: 'disabled' });
  });

  it('should show a post hidden only by a video if the video toggle is off (TC-086 rule)', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, contentTypes: { image: true, gif: true, video: false } };
    const decision = await decide({ settings, items: [item('video', { seen: seen('exact') })] });
    expect(decision).toEqual({ hide: false, reason: 'no-media' });
  });

  it('should keep a post hidden by its image if the video toggle is off (TC-086 rule)', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, contentTypes: { image: true, gif: true, video: false } };
    const decision = await decide({ settings, items: [item('image', { seen: seen('exact') }), item('video')] });
    expect(decision).toMatchObject({ hide: true, matchClass: 'exact' });
  });

  it('should ignore a gif item if the gif toggle is off', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, contentTypes: { image: true, gif: false, video: true } };
    const decision = await decide({ settings, items: [item('gif', { seen: seen('exact') })] });
    expect(decision).toEqual({ hide: false, reason: 'no-media' });
  });
});
