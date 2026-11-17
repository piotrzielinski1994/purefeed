// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fragment, loadFixture, setUrl } from '../../test/helpers/fixtures.ts';
import { redditImagePost } from '../../test/helpers/platform-markup.ts';
import type { DetectedPost, PlatformAdapter } from './adapter.ts';

const loadAdapter = async (): Promise<PlatformAdapter> => (await import('./reddit.ts')).redditAdapter;

const IMG_PRIMARY = 'https://preview.redd.it/pf-base-v0-1pfimg1.png?width=640&crop=smart&auto=webp&s=pf01';
const GIF_SRC = 'https://preview.redd.it/pf-loop-v0-1pfgif1.gif?width=640&format=mp4&s=pfgif1';
const GIF_POSTER = 'https://preview.redd.it/pf-loop-v0-1pfgif1.gif?width=640&crop=smart&format=png8&s=pfgifp';
const VIDEO_SRC = 'https://packaged-media.redd.it/1pfvid1/pb/m2-res_720p.mp4?m=DASHPlaylist.mpd&v=1';
const VIDEO_POSTER = 'https://external-preview.redd.it/pf-clip-v0-1pfvid1.jpeg?width=640&crop=smart&format=pjpg&s=pfvidp';

function readAll(adapter: PlatformAdapter): DetectedPost[] {
  return [...document.querySelectorAll(adapter.postSelector)].map((el) => adapter.readPost(el)).filter((p): p is DetectedPost => p !== null);
}

function postByKey(posts: DetectedPost[], key: string): DetectedPost {
  const post = posts.find((p) => p.postKey === key);
  if (!post) throw new Error(`post ${key} not detected`);
  return post;
}

const shadowVideo = (postId: string): HTMLVideoElement => {
  const player = document.querySelector(`#${postId} shreddit-player`);
  const video = player?.shadowRoot?.querySelector('video');
  if (!video) throw new Error(`no player video in ${postId}`);
  return video;
};

beforeEach(() => {
  setUrl('https://www.reddit.com/');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('Reddit adapter posts and keys (AC-042, TC-059)', () => {
  it('should read every home feed post with key reddit:t3_<id>, author and subreddit source keys and an absolute permalink (TC-059)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const posts = readAll(adapter);
    expect(adapter.platform).toBe('reddit');
    expect(posts.map((p) => p.postKey)).toEqual([
      'reddit:t3_1pfimg1',
      'reddit:t3_1pfgal1',
      'reddit:t3_1pfgif1',
      'reddit:t3_1pfvid1',
      'reddit:t3_1pftxt1',
      'reddit:t3_1pflnk1',
    ]);
    const image = postByKey(posts, 'reddit:t3_1pfimg1');
    expect(image.el).toBe(document.getElementById('t3_1pfimg1'));
    expect(image.authorKey).toBe('reddit:u/pf_alice');
    expect(image.sourceKeys).toHaveLength(2);
    expect(image.sourceKeys).toEqual(expect.arrayContaining(['reddit:u/pf_alice', 'reddit:r/pf_memes']));
    expect(image.permalink).toBe('https://www.reddit.com/r/pf_memes/comments/1pfimg1/synthetic_image_post/');
    expect(postByKey(posts, 'reddit:t3_1pfvid1').sourceKeys).toEqual(expect.arrayContaining(['reddit:u/pf_dave', 'reddit:r/pf_videos']));
  });

  it('should never treat a promoted post as a post', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const ad = document.querySelector('shreddit-ad-post') as Element;
    expect(ad.matches(adapter.postSelector) && adapter.readPost(ad) !== null).toBe(false);
    expect(readAll(adapter).map((p) => p.postKey)).not.toContain('reddit:t3_1pfad01');
  });

  it('should read subreddit feed posts with their keys, sources and media (TC-059)', async () => {
    setUrl('https://www.reddit.com/r/pf_memes/');
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/subreddit.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual(['reddit:t3_1pfsub1', 'reddit:t3_1pfsub2']);
    const image = postByKey(posts, 'reddit:t3_1pfsub1');
    expect(image.sourceKeys).toEqual(expect.arrayContaining(['reddit:u/pf_gina', 'reddit:r/pf_memes']));
    expect(image.media.map((m) => [m.el, m.contentType])).toEqual([
      [document.querySelector('#t3_1pfsub1 img[data-post-media-primary]'), 'image'],
    ]);
    const video = postByKey(posts, 'reddit:t3_1pfsub2');
    expect(video.media).toEqual([
      {
        el: shadowVideo('t3_1pfsub2'),
        contentType: 'video',
        posterUrl: 'https://preview.redd.it/pf-sub-clip-v0-1pfsub2.jpeg?width=640&format=pjpg&s=pfs2p',
      },
    ]);
  });

  it('should read search result posts with their keys, sources and gallery media (TC-059)', async () => {
    setUrl('https://www.reddit.com/search/?q=pf');
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/search.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual(['reddit:t3_1pfsrc1', 'reddit:t3_1pfsrc2']);
    expect(postByKey(posts, 'reddit:t3_1pfsrc1').sourceKeys).toEqual(expect.arrayContaining(['reddit:u/pf_ivy', 'reddit:r/pf_cats']));
    const gallery = postByKey(posts, 'reddit:t3_1pfsrc2');
    expect(gallery.permalink).toBe('https://www.reddit.com/r/pf_cats/comments/1pfsrc2/synthetic_search_gallery/');
    expect(gallery.media.map((m) => m.el)).toEqual([...document.querySelectorAll('#t3_1pfsrc2 li figure img')]);
  });

  it('should return the same post key for the same element on every read and after the element moves', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const el = document.getElementById('t3_1pfgal1') as Element;
    const first = adapter.readPost(el);
    const second = adapter.readPost(el);
    document.querySelector('shreddit-feed')?.prepend(el);
    const moved = adapter.readPost(el);
    expect(first?.postKey).toBe('reddit:t3_1pfgal1');
    expect(second?.postKey).toBe(first?.postKey);
    expect(moved?.postKey).toBe(first?.postKey);
  });

  it('should read the new key, sources and media if the feed recycles a post element for another post', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const el = document.getElementById('t3_1pfimg1') as Element;
    expect(adapter.readPost(el)?.postKey).toBe('reddit:t3_1pfimg1');
    const next = fragment(
      document,
      redditImagePost({ id: '1pfnew9', author: 'pf_zed', sub: 'pf_other', src: 'https://preview.redd.it/pf-new-v0-9.png?width=640' }),
    ).firstElementChild as Element;
    for (const name of next.getAttributeNames()) el.setAttribute(name, next.getAttribute(name) ?? '');
    el.replaceChildren(...next.childNodes);
    const post = adapter.readPost(el);
    expect(post?.postKey).toBe('reddit:t3_1pfnew9');
    expect(post?.sourceKeys).toEqual(expect.arrayContaining(['reddit:u/pf_zed', 'reddit:r/pf_other']));
    expect(post?.permalink).toBe('https://www.reddit.com/r/pf_other/comments/1pfnew9/synthetic_post_1pfnew9/');
    expect(post?.media.map((m) => m.el.getAttribute('src'))).toEqual(['https://preview.redd.it/pf-new-v0-9.png?width=640']);
  });
});

describe('Reddit adapter media (AC-042, AC-014, TC-018)', () => {
  it('should detect only the primary image of an image post, not its blurred backdrop or hidden lightbox copy', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const post = adapter.readPost(document.getElementById('t3_1pfimg1') as Element);
    const primary = document.querySelector('#t3_1pfimg1 img[data-post-media-primary]');
    expect(post?.media).toEqual([{ el: primary, contentType: 'image', posterUrl: null }]);
    expect(primary?.getAttribute('src')).toBe(IMG_PRIMARY);
  });

  it('should detect one image per gallery slide, also a lazy slide that has only a srcset', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const post = adapter.readPost(document.getElementById('t3_1pfgal1') as Element);
    const slides = [...document.querySelectorAll('#t3_1pfgal1 li figure > img')];
    expect(slides).toHaveLength(3);
    expect(slides[2].hasAttribute('src')).toBe(false);
    expect(post?.media.map((m) => m.el)).toEqual(slides);
    expect(post?.media.every((m) => m.contentType === 'image' && m.posterUrl === null)).toBe(true);
  });

  it('should mark a GIF converted to MP4 as content type gif with its poster (TC-018)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const post = adapter.readPost(document.getElementById('t3_1pfgif1') as Element);
    const video = shadowVideo('t3_1pfgif1');
    expect(video.getAttribute('src')).toBe(GIF_SRC);
    expect(post?.media).toEqual([{ el: video, contentType: 'gif', posterUrl: GIF_POSTER }]);
  });

  it('should detect the player video in the shreddit-player shadow root as content type video with its poster (TC-018)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const post = adapter.readPost(document.getElementById('t3_1pfvid1') as Element);
    const video = shadowVideo('t3_1pfvid1');
    expect(video.getAttribute('src')).toBe(VIDEO_SRC);
    expect(post?.media).toEqual([{ el: video, contentType: 'video', posterUrl: VIDEO_POSTER }]);
  });

  it('should detect no media in a text post and in a link post with a link thumbnail', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    expect(adapter.readPost(document.getElementById('t3_1pftxt1') as Element)?.media).toEqual([]);
    const link = adapter.readPost(document.getElementById('t3_1pflnk1') as Element);
    expect(link?.postKey).toBe('reddit:t3_1pflnk1');
    expect(link?.media).toEqual([]);
  });

  it('should never report an avatar, a video poster image or a scrubbing preview video as media', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/home.html');
    const media = readAll(adapter).flatMap((p) => p.media.map((m) => m.el));
    expect(media.length).toBeGreaterThan(0);
    for (const el of media) {
      expect(el.getAttribute('alt') ?? '', el.outerHTML).not.toMatch(/avatar|media poster/);
      expect(el.getAttribute('slot')).not.toBe('poster');
      expect(el.getAttribute('src') ?? '').not.toContain('CMAF_96.mp4');
    }
  });

  it('should detect a lazy image once the feed sets its src', async () => {
    const adapter = await loadAdapter();
    const el = fragment(document, redditImagePost({ id: '1pflazy', author: 'pf_lazy', src: null }));
    document.body.append(el);
    const post = el.querySelector('shreddit-post') as Element;
    const primary = post.querySelector('img[data-post-media-primary]') as HTMLImageElement;
    primary.setAttribute('src', 'https://preview.redd.it/pf-lazy-v0.png?width=640');
    expect(adapter.readPost(post)?.media.map((m) => m.el)).toEqual([primary]);
  });
});

describe('Reddit adapter permalink page and scope (AC-031, spec 1.1)', () => {
  it('should return the focal post key of a post permalink URL and none for feed URLs', async () => {
    const adapter = await loadAdapter();
    expect(adapter.focalPostKey(new URL('https://www.reddit.com/r/pf_memes/comments/1pfprm1/synthetic_focal_post/'))).toBe('reddit:t3_1pfprm1');
    expect(adapter.focalPostKey(new URL('https://www.reddit.com/r/pf_memes/comments/1pfprm1/synthetic_focal_post/?rdt=4242'))).toBe(
      'reddit:t3_1pfprm1',
    );
    expect(adapter.focalPostKey(new URL('https://www.reddit.com/r/pf_memes/comments/1pfprm1/'))).toBe('reddit:t3_1pfprm1');
    for (const url of ['https://www.reddit.com/', 'https://www.reddit.com/r/pf_memes/', 'https://www.reddit.com/search/?q=pf']) {
      expect(adapter.focalPostKey(new URL(url)), url).toBeNull();
    }
  });

  it('should read only the focal post on its permalink page and ignore comments with images', async () => {
    setUrl('https://www.reddit.com/r/pf_memes/comments/1pfprm1/synthetic_focal_post/');
    const adapter = await loadAdapter();
    loadFixture(document, 'reddit/permalink.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual(['reddit:t3_1pfprm1']);
    expect(posts[0].media.map((m) => m.el)).toEqual([document.querySelector('#t3_1pfprm1 img[data-post-media-primary]')]);
    const comment = document.querySelector('shreddit-comment') as Element;
    expect(comment.matches(adapter.postSelector) && adapter.readPost(comment) !== null).toBe(false);
  });
});

describe('Reddit adapter popular and all feeds (AC-042)', () => {
  const FEEDS = [
    {
      view: 'r/popular',
      url: 'https://www.reddit.com/r/popular/',
      fixture: 'reddit/popular.html',
      image: { id: 't3_1pfpop1', author: 'pf_paula', sub: 'pf_popular_memes' },
      gif: { id: 't3_1pfpop2', author: 'pf_pete', sub: 'pf_popular_gifs' },
    },
    {
      view: 'r/all',
      url: 'https://www.reddit.com/r/all/',
      fixture: 'reddit/all.html',
      image: { id: 't3_1pfall2', author: 'pf_adam', sub: 'pf_all_memes' },
      gif: { id: 't3_1pfall1', author: 'pf_anna', sub: 'pf_all_gifs' },
    },
  ];
  for (const feed of FEEDS) {
    it(`should read ${feed.view} feed posts with key reddit:t3_<id>, author and subreddit source keys and image and GIF media`, async () => {
      setUrl(feed.url);
      const adapter = await loadAdapter();
      loadFixture(document, feed.fixture);
      const posts = readAll(adapter);
      expect(posts.map((p) => p.postKey).sort()).toEqual([`reddit:${feed.image.id}`, `reddit:${feed.gif.id}`].sort());
      for (const { id, author, sub } of [feed.image, feed.gif]) {
        const post = postByKey(posts, `reddit:${id}`);
        expect(post.sourceKeys.toSorted()).toEqual([`reddit:r/${sub}`, `reddit:u/${author}`]);
        expect(post.permalink).toMatch(new RegExp(`^https://www\\.reddit\\.com/r/${sub}/comments/${id.slice(3)}/`));
      }
      expect(postByKey(posts, `reddit:${feed.image.id}`).media.map((m) => [m.el, m.contentType])).toEqual([
        [document.querySelector(`#${feed.image.id} img[data-post-media-primary]`), 'image'],
      ]);
      expect(postByKey(posts, `reddit:${feed.gif.id}`).media.map((m) => [m.el, m.contentType])).toEqual([[shadowVideo(feed.gif.id), 'gif']]);
      const postMedia = new Set(posts.flatMap((p) => p.media.map((m) => m.el)));
      expect(
        [...document.querySelectorAll('main img')].filter((img) => !img.closest('shreddit-post') && postMedia.has(img as HTMLImageElement)),
      ).toEqual([]);
      expect(adapter.focalPostKey(new URL(feed.url))).toBeNull();
    });
  }
});
