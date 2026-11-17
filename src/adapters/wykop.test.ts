// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fragment, loadFixture, setUrl } from '../../test/helpers/fixtures.ts';
import { wykopImageEntry } from '../../test/helpers/platform-markup.ts';
import type { DetectedPost, PlatformAdapter } from './adapter.ts';

const loadAdapter = async (): Promise<PlatformAdapter> => (await import('./wykop.ts')).wykopAdapter;

function readAll(adapter: PlatformAdapter): DetectedPost[] {
  return [...document.querySelectorAll(adapter.postSelector)].map((el) => adapter.readPost(el)).filter((p): p is DetectedPost => p !== null);
}

function postByKey(posts: DetectedPost[], key: string): DetectedPost {
  const post = posts.find((p) => p.postKey === key);
  if (!post) throw new Error(`post ${key} not detected`);
  return post;
}

const entryMedia = (id: string): Element[] => [
  ...document.querySelectorAll(`#thread-${id} > section.item .media img, #thread-${id} > section.item .media video`),
];

beforeEach(() => {
  setUrl('https://wykop.pl/mikroblog');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('Wykop adapter microblog (AC-043, TC-060)', () => {
  it('should read each microblog entry as one post with key wykop:entry:<id>, source key wykop:@<author> and an absolute permalink (TC-060)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const posts = readAll(adapter);
    expect(adapter.platform).toBe('wykop');
    expect(posts.map((p) => p.postKey)).toEqual([
      'wykop:entry:1001',
      'wykop:entry:1002',
      'wykop:entry:1003',
      'wykop:entry:1004',
      'wykop:entry:1005',
      'wykop:entry:1006',
    ]);
    const first = postByKey(posts, 'wykop:entry:1001');
    expect(first.el).toBe(document.getElementById('thread-1001'));
    expect(first.sourceKeys).toEqual(['wykop:@pf_ala']);
    expect(first.authorKey).toBe('wykop:@pf_ala');
    expect(first.permalink).toBe('https://wykop.pl/wpis/1001/syntetyczny-wpis-ze-zdjeciem');
  });

  it('should detect the entry photo with its srcset and ignore the avatar, emoji and the photos of comments', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const post = adapter.readPost(document.getElementById('thread-1001') as Element);
    const photo = document.querySelector('#thread-1001 > section.item .photos img') as Element;
    expect(photo.getAttribute('srcset')).toContain('2x');
    expect(post?.media).toEqual([{ el: photo, contentType: 'image', posterUrl: null }]);
  });

  it('should never read a comment thread as a post (spec 1.1)', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const comment = document.getElementById('thread-3001') as Element;
    expect(comment.matches(adapter.postSelector) && adapter.readPost(comment) !== null).toBe(false);
    expect(readAll(adapter).flatMap((p) => p.media.map((m) => m.el.getAttribute('src')))).not.toContain(
      'https://wykop.pl/cdn/c3201142/pf-comment-3001,w400.webp',
    );
  });

  it('should detect every photo of a gallery entry', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const post = adapter.readPost(document.getElementById('thread-1002') as Element);
    expect(post?.media.map((m) => m.el)).toEqual(entryMedia('1002'));
    expect(post?.media).toHaveLength(2);
    expect(post?.media.every((m) => m.contentType === 'image')).toBe(true);
  });

  it('should detect an animated GIF photo as an image media item that the decoder types later', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const post = adapter.readPost(document.getElementById('thread-1003') as Element);
    expect(post?.media.map((m) => m.el)).toEqual(entryMedia('1003'));
    expect(['image', 'gif']).toContain(post?.media[0]?.contentType);
  });

  it('should detect a video in the entry body as content type video with its poster', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const post = adapter.readPost(document.getElementById('thread-1004') as Element);
    expect(post?.media).toEqual([
      {
        el: document.querySelector('#thread-1004 video'),
        contentType: 'video',
        posterUrl: 'https://wykop.pl/cdn/c3201142/pf-clip-1004-poster,w400.jpg',
      },
    ]);
  });

  it('should detect no media in a text entry and in an entry whose only media is a third-party embed preview', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    expect(adapter.readPost(document.getElementById('thread-1005') as Element)?.media).toEqual([]);
    const embed = adapter.readPost(document.getElementById('thread-1006') as Element);
    expect(embed?.postKey).toBe('wykop:entry:1006');
    expect(embed?.media).toEqual([]);
  });

  it('should ignore sidebar entry and link summaries and ad slots', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const keys = readAll(adapter).map((p) => p.postKey);
    expect(keys).toContain('wykop:entry:1001');
    expect(keys).not.toContain('wykop:entry:1007');
    expect(keys).not.toContain('wykop:link:9001');
    for (const el of document.querySelectorAll('section.sidebar section.entry, section.sidebar section.link, section.pub-slot-wrapper')) {
      expect(el.matches(adapter.postSelector) && adapter.readPost(el) !== null, el.className).toBe(false);
    }
  });

  it('should return the same post key for the same element on every read and after the element moves', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const el = document.getElementById('thread-1002') as Element;
    const first = adapter.readPost(el);
    document.querySelector('section.listing > div.content')?.prepend(el);
    expect(first?.postKey).toBe('wykop:entry:1002');
    expect(adapter.readPost(el)?.postKey).toBe(first?.postKey);
  });

  it('should read the new key and media if the list recycles an entry element for another entry', async () => {
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/microblog.html');
    const el = document.getElementById('thread-1005') as Element;
    expect(adapter.readPost(el)?.postKey).toBe('wykop:entry:1005');
    const next = fragment(
      document,
      wykopImageEntry({ id: '1099', author: 'pf_olek', src: 'https://wykop.pl/cdn/c3201142/pf-recycled-1099,w400.jpg' }),
    );
    el.id = next.id;
    el.replaceChildren(...next.childNodes);
    const post = adapter.readPost(el);
    expect(post?.postKey).toBe('wykop:entry:1099');
    expect(post?.sourceKeys).toEqual(['wykop:@pf_olek']);
    expect(post?.media.map((m) => m.el.getAttribute('src'))).toEqual(['https://wykop.pl/cdn/c3201142/pf-recycled-1099,w400.jpg']);
  });

  it('should detect a lazy entry photo once the list sets its src', async () => {
    const adapter = await loadAdapter();
    const el = fragment(document, wykopImageEntry({ id: '1098', author: 'pf_lazy', src: null }));
    document.body.append(el);
    const photo = el.querySelector('.photos img') as HTMLImageElement;
    photo.setAttribute('src', 'https://wykop.pl/cdn/c3201142/pf-lazy-1098,w400.jpg');
    expect(adapter.readPost(el)?.media.map((m) => m.el)).toEqual([photo]);
  });
});

describe('Wykop adapter link list (AC-043, TC-060)', () => {
  it('should read each link as one post with key wykop:link:<id> and source key wykop:@<author> (TC-060)', async () => {
    setUrl('https://wykop.pl/');
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/links.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual(['wykop:link:5001', 'wykop:link:5002']);
    const first = postByKey(posts, 'wykop:link:5001');
    expect(first.el).toBe(document.getElementById('link-5001'));
    expect(first.sourceKeys).toEqual(['wykop:@pf_jan']);
    expect(first.authorKey).toBe('wykop:@pf_jan');
    expect(first.permalink).toBe('https://wykop.pl/link/5001/syntetyczne-znalezisko-pierwsze');
    expect(postByKey(posts, 'wykop:link:5002').sourceKeys).toEqual(['wykop:@pf_kasia']);
  });

  it('should never fingerprint link thumbnails (TC-060)', async () => {
    setUrl('https://wykop.pl/');
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/links.html');
    const posts = readAll(adapter);
    expect(posts).toHaveLength(2);
    expect(posts.flatMap((p) => p.media)).toEqual([]);
  });
});

describe('Wykop adapter permalink pages (AC-031, spec 1.1)', () => {
  it('should return the focal post key of entry and link permalink URLs and none for list URLs', async () => {
    const adapter = await loadAdapter();
    expect(adapter.focalPostKey(new URL('https://wykop.pl/wpis/2001/syntetyczny-wpis-glowny'))).toBe('wykop:entry:2001');
    expect(adapter.focalPostKey(new URL('https://wykop.pl/link/5001/syntetyczne-znalezisko-pierwsze'))).toBe('wykop:link:5001');
    for (const url of ['https://wykop.pl/', 'https://wykop.pl/mikroblog', 'https://wykop.pl/tag/pf_test', 'https://wykop.pl/ludzie/pf_ala']) {
      expect(adapter.focalPostKey(new URL(url)), url).toBeNull();
    }
  });

  it('should read only the entry on its permalink page and ignore replies at every depth', async () => {
    setUrl('https://wykop.pl/wpis/2001/syntetyczny-wpis-glowny');
    const adapter = await loadAdapter();
    loadFixture(document, 'wykop/entry-permalink.html');
    const posts = readAll(adapter);
    expect(posts.map((p) => p.postKey)).toEqual(['wykop:entry:2001']);
    expect(posts[0].sourceKeys).toEqual(['wykop:@pf_lena']);
    expect(posts[0].media.map((m) => m.el.getAttribute('src'))).toEqual(['https://wykop.pl/cdn/c3201142/pf-entry-2001,w400.jpg']);
  });
});
