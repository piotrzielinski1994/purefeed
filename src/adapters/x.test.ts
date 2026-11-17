// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fragment, loadFixture, setUrl } from '../../test/helpers/fixtures.ts';
import { xPhotoTweet } from '../../test/helpers/platform-markup.ts';
import type { DetectedPost, PlatformAdapter } from './adapter.ts';

const loadAdapter = async (): Promise<PlatformAdapter> => (await import('./x.ts')).xAdapter;

const STATUS = (n: number) => `186000000000000000${n}`;

function readAll(adapter: PlatformAdapter): DetectedPost[] {
  return [...document.querySelectorAll(adapter.postSelector)].map((el) => adapter.readPost(el)).filter((p): p is DetectedPost => p !== null);
}

function postByKey(posts: DetectedPost[], key: string): DetectedPost {
  const post = posts.find((p) => p.postKey === key);
  if (!post) throw new Error(`post ${key} not detected`);
  return post;
}

const tweet = (n: number): Element => {
  const el = document.querySelectorAll('article[data-testid="tweet"]')[n - 1];
  if (!el) throw new Error(`tweet ${n} not in fixture`);
  return el;
};

beforeEach(() => {
  setUrl('https://x.com/home');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('X adapter timeline (AC-044, TC-061)', () => {
  it('should read each timeline tweet as one post with key x:<statusId>, source key x:@<handle> and an absolute permalink (TC-061)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const posts = readAll(adapter);
    expect(adapter.platform).toBe('x');
    expect(posts.map((p) => p.postKey)).toEqual([
      `x:${STATUS(1)}`,
      `x:${STATUS(2)}`,
      `x:${STATUS(3)}`,
      `x:${STATUS(4)}`,
      `x:${STATUS(5)}`,
      `x:${STATUS(6)}`,
      `x:${STATUS(8)}`,
    ]);
    const first = postByKey(posts, `x:${STATUS(1)}`);
    expect(first.el).toBe(tweet(1));
    expect(first.sourceKeys).toEqual(['x:@pf_xavier']);
    expect(first.authorKey).toBe('x:@pf_xavier');
    expect(first.permalink).toBe(`https://x.com/pf_xavier/status/${STATUS(1)}`);
  });

  it('should read a reposted tweet with the key and source of the original tweet', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(8));
    expect(post?.postKey).toBe(`x:${STATUS(8)}`);
    expect(post?.sourceKeys).toEqual(['x:@pf_eli']);
    expect(post?.permalink).toBe(`https://x.com/pf_eli/status/${STATUS(8)}`);
  });

  it('should treat a promoted tweet without a status link as no post', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    expect(adapter.readPost(tweet(7))).toBeNull();
  });

  it('should return the same post key for the same element on every read and after the element moves', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const el = tweet(2);
    const first = adapter.readPost(el);
    document.querySelector('[aria-label="Timeline: Your Home Timeline"] > div')?.append(el.closest('[data-testid="cellInnerDiv"]') as Element);
    expect(first?.postKey).toBe(`x:${STATUS(2)}`);
    expect(adapter.readPost(el)?.postKey).toBe(first?.postKey);
  });

  it('should read the new key and media if the virtualized timeline recycles a tweet element', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const el = tweet(6);
    expect(adapter.readPost(el)?.postKey).toBe(`x:${STATUS(6)}`);
    const next = fragment(
      document,
      xPhotoTweet({ id: '1860000000000000999', author: 'pf_reuse', src: 'https://pbs.twimg.com/media/PfRecycled?format=jpg&name=small' }),
    );
    const nextArticle = next.querySelector('article') as Element;
    el.replaceChildren(...nextArticle.childNodes);
    const post = adapter.readPost(el);
    expect(post?.postKey).toBe('x:1860000000000000999');
    expect(post?.sourceKeys).toEqual(['x:@pf_reuse']);
    expect(post?.media.map((m) => m.el.getAttribute('src'))).toEqual(['https://pbs.twimg.com/media/PfRecycled?format=jpg&name=small']);
  });
});

describe('X adapter media (AC-044, AC-014, TC-018, TC-061)', () => {
  it('should detect the tweet photo with its srcset and ignore the avatar and emoji images', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(1));
    const photo = tweet(1).querySelector('[data-testid="tweetPhoto"] img') as Element;
    expect(photo.getAttribute('srcset')).toContain('name=large');
    expect(post?.media).toEqual([{ el: photo, contentType: 'image', posterUrl: null }]);
  });

  it('should detect every photo of a multi-photo tweet', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(2));
    expect(post?.media.map((m) => m.el)).toEqual([...tweet(2).querySelectorAll('[data-testid="tweetPhoto"] img')]);
    expect(post?.media).toHaveLength(2);
  });

  it('should mark a GIF video from video.twimg.com/tweet_video as content type gif with its poster (TC-018)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(3));
    expect(post?.media).toEqual([
      { el: tweet(3).querySelector('video'), contentType: 'gif', posterUrl: 'https://pbs.twimg.com/tweet_video_thumb/PfLoopGif.jpg' },
    ]);
  });

  it('should mark a video with a GIF badge as content type gif before its src is set (TC-018)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const video = tweet(3).querySelector('video') as HTMLVideoElement;
    video.removeAttribute('src');
    expect(adapter.readPost(tweet(3))?.media.map((m) => m.contentType)).toEqual(['gif']);
  });

  it('should detect an ordinary tweet video as content type video with its poster (TC-018)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(4));
    expect(post?.media).toEqual([
      {
        el: tweet(4).querySelector('video'),
        contentType: 'video',
        posterUrl: `https://pbs.twimg.com/amplify_video_thumb/${STATUS(4)}/img/PfClip.jpg`,
      },
    ]);
  });

  it('should assign the photo of a quoted tweet to the outer tweet (TC-061)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const posts = readAll(adapter);
    const outer = postByKey(posts, `x:${STATUS(5)}`);
    expect(outer.sourceKeys).toEqual(['x:@pf_bea']);
    expect(outer.media.map((m) => m.el.getAttribute('src'))).toEqual(['https://pbs.twimg.com/media/PfQuoted?format=jpg&name=small']);
    expect(posts.filter((p) => p.media.some((m) => m.el.getAttribute('src')?.includes('PfQuoted')))).toHaveLength(1);
  });

  it('should detect no media in a tweet whose only image is a link card', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'x/home.html');
    const post = adapter.readPost(tweet(6));
    expect(post?.postKey).toBe(`x:${STATUS(6)}`);
    expect(post?.media).toEqual([]);
  });

  it('should detect a lazy tweet photo once the timeline sets its src', async () => {
    const adapter = await loadAdapter();
    const el = fragment(document, xPhotoTweet({ id: '1860000000000000777', author: 'pf_lazy', src: null }));
    document.body.append(el);
    const article = el.querySelector('article') as Element;
    const photo = article.querySelector('[data-testid="tweetPhoto"] img') as HTMLImageElement;
    photo.setAttribute('src', 'https://pbs.twimg.com/media/PfLazy?format=jpg&name=small');
    expect(adapter.readPost(article)?.media.map((m) => m.el)).toEqual([photo]);
  });
});

describe('X adapter status page (AC-031, AC-044, spec 1.1)', () => {
  it('should return the focal post key of a status URL and none for timeline URLs (TC-044)', async () => {
    const adapter = await loadAdapter();
    expect(adapter.focalPostKey(new URL(`https://x.com/pf_xavier/status/${STATUS(1)}`))).toBe(`x:${STATUS(1)}`);
    expect(adapter.focalPostKey(new URL(`https://x.com/pf_xavier/status/${STATUS(1)}/photo/1`))).toBe(`x:${STATUS(1)}`);
    for (const url of ['https://x.com/home', 'https://x.com/pf_xavier', 'https://x.com/search?q=pf', 'https://x.com/i/lists/42']) {
      expect(adapter.focalPostKey(new URL(url)), url).toBeNull();
    }
  });

  it('should read the focal tweet on its status page and ignore reply tweets', async () => {
    setUrl(`https://x.com/pf_xavier/status/${STATUS(1)}`);
    const adapter = await loadAdapter();
    loadFixture(document, 'x/status.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual([`x:${STATUS(1)}`]);
    expect(posts[0].sourceKeys).toEqual(['x:@pf_xavier']);
    expect(posts[0].media.map((m) => m.el.getAttribute('src'))).toEqual(['https://pbs.twimg.com/media/PfPhotoA?format=jpg&name=medium']);
  });
});

describe('X adapter search, list and profile timelines (AC-044)', () => {
  const TIMELINES = [
    {
      view: 'search',
      url: 'https://x.com/search?q=pf&src=typed_query',
      fixture: 'x/search.html',
      tweets: [
        { status: '1860000000000009101', handle: 'pf_seeker', media: 'image' },
        { status: '1860000000000009102', handle: 'pf_finder', media: 'gif' },
      ],
    },
    {
      view: 'list',
      url: 'https://x.com/i/lists/1860000000000009200',
      fixture: 'x/list.html',
      tweets: [
        { status: '1860000000000009201', handle: 'pf_member_a', media: 'video' },
        { status: '1860000000000009202', handle: 'pf_member_b', media: 'image' },
      ],
    },
    {
      view: 'profile',
      url: 'https://x.com/pf_owner',
      fixture: 'x/profile.html',
      tweets: [
        { status: '1860000000000009301', handle: 'pf_owner', media: 'image' },
        { status: '1860000000000009302', handle: 'pf_original', media: 'gif' },
      ],
    },
  ];
  for (const timeline of TIMELINES) {
    it(`should read each ${timeline.view} timeline tweet as one post with key x:<statusId>, source key x:@<handle> and its media type`, async () => {
      setUrl(timeline.url);
      const adapter = await loadAdapter();
      loadFixture(document, timeline.fixture);
      const posts = readAll(adapter);
      expect(
        posts.map((p) => ({ key: p.postKey, sources: p.sourceKeys, permalink: p.permalink, types: p.media.map((m) => m.contentType) })),
      ).toEqual(
        timeline.tweets.map((t) => ({
          key: `x:${t.status}`,
          sources: [`x:@${t.handle}`],
          permalink: `https://x.com/${t.handle}/status/${t.status}`,
          types: [t.media],
        })),
      );
      const postMedia = new Set(posts.flatMap((p) => p.media.map((m) => m.el)));
      expect(
        [...document.querySelectorAll('img, video')].filter((el) => postMedia.has(el as HTMLImageElement) && !el.closest('article')),
      ).toEqual([]);
      expect(postMedia.size).toBe(2);
      expect(adapter.focalPostKey(new URL(timeline.url))).toBeNull();
    });
  }
});
