// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { settle } from '../../test/helpers/fake-ext.ts';
import { createTestAdapter, makeFeed, makePost, type PostSpec } from '../../test/helpers/test-adapter.ts';
import type { DetectedPost } from '../adapters/adapter.ts';

const loadScanner = () => import('./scanner.ts');

afterEach(() => {
  document.body.replaceChildren();
});

const spec = (id: string): PostSpec => ({ id, author: 'alice', media: [{ kind: 'img', src: `https://i.redd.it/${id}.png` }] });

async function setup(initial: PostSpec[] = [spec('p1'), spec('p2')]) {
  const { createPostScanner } = await loadScanner();
  const { feed, posts } = makeFeed(document, initial);
  const seen: DetectedPost[] = [];
  const changed: Array<{ el: Element; oldKey: string }> = [];
  const scanner = createPostScanner({
    root: document.body,
    adapter: createTestAdapter(),
    onPost: (p) => seen.push(p),
    onKeyChanged: (el, oldKey) => changed.push({ el, oldKey }),
  });
  return { scanner, feed, posts, seen, changed };
}

const keys = (posts: DetectedPost[]) => posts.map((p) => p.postKey);

describe('createPostScanner (AC-045, AC-046)', () => {
  it('should report each post present at scan time once', async () => {
    const { scanner, seen, posts } = await setup();
    scanner.scanNow();
    await settle();
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2']);
    expect(seen[0].el).toBe(posts[0]);
    scanner.disconnect();
  });

  it('should report posts inserted after load without a rescan (TC-062)', async () => {
    const { scanner, feed, seen } = await setup();
    scanner.scanNow();
    feed.append(makePost(document, spec('p3')));
    await settle();
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2', 'reddit:t3_p3']);
    scanner.disconnect();
  });

  it('should report every post of 2 infinite scroll batches of 10 (TC-062)', async () => {
    const { scanner, feed, seen } = await setup([]);
    scanner.scanNow();
    for (const batch of [0, 1]) {
      const wrapper = document.createElement('div');
      wrapper.append(...Array.from({ length: 10 }, (_, i) => makePost(document, spec(`b${batch}x${i}`))));
      feed.append(wrapper);
      await settle();
    }
    expect(seen).toHaveLength(20);
    expect(new Set(keys(seen)).size).toBe(20);
    scanner.disconnect();
  });

  it('should not report a processed post again if a mutation touches it 50 times (TC-064)', async () => {
    const { scanner, seen, posts } = await setup();
    scanner.scanNow();
    await settle();
    for (let i = 0; i < 50; i++) {
      posts[0].className = `tick-${i}`;
      posts[0].querySelector('p')?.append(document.createTextNode('.'));
      const badge = document.createElement('span');
      posts[0].append(badge);
      await settle(1);
    }
    await settle();
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2']);
    scanner.disconnect();
  });

  it('should not report a post element again if the feed detaches and re-attaches it with the same key', async () => {
    const { scanner, feed, seen, posts } = await setup();
    scanner.scanNow();
    await settle();
    posts[0].remove();
    await settle();
    feed.append(posts[0]);
    await settle();
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2']);
    scanner.disconnect();
  });

  it('should report a new element that re-renders a known post key', async () => {
    const { scanner, feed, seen, posts } = await setup();
    scanner.scanNow();
    await settle();
    const rerender = makePost(document, spec('p1'));
    feed.replaceChild(rerender, posts[0]);
    await settle();
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2', 'reddit:t3_p1']);
    expect(seen[2].el).toBe(rerender);
    scanner.disconnect();
  });

  it('should report the old key and the new post if a virtualized feed reuses an element for another post (TC-065)', async () => {
    const { scanner, seen, changed, posts } = await setup();
    scanner.scanNow();
    await settle();
    const el = posts[0];
    el.setAttribute('data-post', 'q9');
    const img = el.querySelector('img');
    const replacement = makePost(document, spec('q9')).querySelector('img');
    if (img && replacement) el.replaceChild(replacement, img);
    await settle();
    expect(changed).toEqual([{ el, oldKey: 'reddit:t3_p1' }]);
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2', 'reddit:t3_q9']);
    expect(seen[2].el).toBe(el);
    scanner.disconnect();
  });

  it('should re-read a post if the media src of a recycled element changes with its key (TC-065)', async () => {
    const { scanner, seen, changed, posts } = await setup();
    scanner.scanNow();
    await settle();
    const el = posts[1];
    el.setAttribute('data-post', 'q7');
    el.querySelector('img')?.setAttribute('src', 'https://i.redd.it/q7.png');
    await settle();
    expect(changed).toEqual([{ el, oldKey: 'reddit:t3_p2' }]);
    expect(keys(seen)).toEqual(['reddit:t3_p1', 'reddit:t3_p2', 'reddit:t3_q7']);
    scanner.disconnect();
  });

  it('should skip elements the adapter does not read as posts', async () => {
    const { scanner, feed, seen } = await setup([]);
    scanner.scanNow();
    const ad = makePost(document, spec('ad'));
    ad.removeAttribute('data-post');
    ad.setAttribute('data-ad', '');
    feed.append(ad);
    await settle();
    expect(seen).toEqual([]);
    scanner.disconnect();
  });

  it('should report nothing after disconnect', async () => {
    const { scanner, feed, seen } = await setup([]);
    scanner.scanNow();
    scanner.disconnect();
    feed.append(makePost(document, spec('late')));
    await settle();
    expect(seen).toEqual([]);
  });
});
