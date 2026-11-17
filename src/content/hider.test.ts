// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFeed } from '../../test/helpers/test-adapter.ts';

const loadHider = () => import('./hider.ts');

const EXTENSION_ATTRIBUTE = /\s+data-purefeed-[\w-]+(="[^"]*")?/g;
const withoutExtensionAttributes = (html: string) => html.replace(EXTENSION_ATTRIBUTE, '');
const HIDDEN_RULE = /\[data-purefeed-hidden\]\s*\{[^}]*display:\s*none\s*!important/;

afterEach(() => {
  document.body.replaceChildren();
});

function setup() {
  const { posts } = makeFeed(document, [
    { id: 'a1', author: 'alice', media: [{ kind: 'img', src: 'https://i.redd.it/a.png' }] },
    { id: 'b2', author: 'bob', media: [{ kind: 'img', src: 'https://i.redd.it/b.png' }] },
  ]);
  const indicator = document.createElement('div');
  indicator.setAttribute('data-purefeed-ui', '');
  return { post: posts[0], next: posts[1], indicator };
}

describe('hidePost and revealPost (AC-050)', () => {
  it('should keep the post and all its descendants in the DOM while hidden (TC-069)', async () => {
    const { hidePost } = await loadHider();
    const { post, indicator } = setup();
    const nodes = post.querySelectorAll('*').length;
    hidePost(post, indicator);
    expect(post.isConnected).toBe(true);
    expect(post.querySelectorAll('*')).toHaveLength(nodes);
    expect(post.hasAttribute('data-purefeed-hidden')).toBe(true);
  });

  it('should show the indicator in the place of the post, outside the post', async () => {
    const { hidePost } = await loadHider();
    const { post, next, indicator } = setup();
    hidePost(post, indicator);
    expect(indicator.isConnected).toBe(true);
    expect(post.contains(indicator)).toBe(false);
    expect(indicator.parentNode).toBe(post.parentNode);
    expect([post.previousElementSibling, post.nextElementSibling]).toContain(indicator);
    expect(next.previousElementSibling === indicator || next.previousElementSibling === post).toBe(true);
  });

  it('should restore the original outerHTML without extension-owned attributes after reveal (TC-069)', async () => {
    const { hidePost, revealPost } = await loadHider();
    const { post, indicator } = setup();
    const before = post.outerHTML;
    const feedBefore = post.parentElement?.innerHTML;
    hidePost(post, indicator);
    revealPost(post);
    expect(withoutExtensionAttributes(post.outerHTML)).toBe(before);
    expect(post.hasAttribute('data-purefeed-hidden')).toBe(false);
    expect(indicator.isConnected).toBe(false);
    expect(withoutExtensionAttributes(post.parentElement?.innerHTML ?? '')).toBe(feedBefore);
  });

  it('should keep one indicator if a hidden post is hidden again', async () => {
    const { hidePost } = await loadHider();
    const { post, indicator } = setup();
    const second = document.createElement('div');
    second.setAttribute('data-purefeed-ui', '');
    hidePost(post, indicator);
    hidePost(post, second);
    expect(document.querySelectorAll('[data-purefeed-ui]')).toHaveLength(1);
  });

  it('should leave a post that is not hidden unchanged on reveal', async () => {
    const { revealPost } = await loadHider();
    const { post } = setup();
    const before = document.body.innerHTML;
    revealPost(post);
    expect(document.body.innerHTML).toBe(before);
  });

  it('should hide marked posts through content.css', () => {
    const css = readFileSync(join(import.meta.dirname, 'content.css'), 'utf8');
    expect(css).toMatch(HIDDEN_RULE);
  });
});
