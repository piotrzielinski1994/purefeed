// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../../../test/helpers/fingerprints.ts';

const loadIndicator = () => import('./indicator.ts');

const NOW = Date.UTC(2026, 10, 17, 12);
const WYKOP_PERMALINK = 'https://wykop.pl/wpis/77/tytul';
const HOST_RESET = /:host\s*\{[^}]*all:\s*initial/;
const MAX_HEIGHT = /max-height:\s*56px/;
const FOCUS_VISIBLE = /:focus-visible/;

const shadowInits = new WeakMap<Element, { root: ShadowRoot; mode: string }>();
const originalAttachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, init);
    shadowInits.set(this, { root, mode: init.mode });
    return root;
  };
});

afterEach(() => {
  Element.prototype.attachShadow = originalAttachShadow;
  document.body.replaceChildren();
});

function shadowOf(host: Element): ShadowRoot {
  const captured = shadowInits.get(host);
  if (!captured) throw new Error('host has no shadow root');
  return captured.root;
}

function visibleText(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== 'STYLE') out += visibleText(child);
  }
  return out;
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();

function cssOf(root: ShadowRoot): string {
  const tags = [...root.querySelectorAll('style')].map((s) => s.textContent ?? '');
  const sheets = (root.adoptedStyleSheets ?? []).flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText));
  return [...tags, ...sheets].join('\n');
}

const buttonsOf = (root: ShadowRoot) => [...root.querySelectorAll('button')];
const labelsOf = (root: ShadowRoot) => buttonsOf(root).map((b) => normalized(b.textContent ?? ''));

async function render(
  overrides: Partial<{
    matchClass: 'exact' | 'near';
    platform: 'reddit' | 'wykop' | 'x';
    firstSeenAt: number;
    authorLabel: string | null;
  }> = {},
) {
  const { createIndicator } = await loadIndicator();
  const actions = { onShow: vi.fn(), onAlwaysShowPost: vi.fn(), onAlwaysShowAuthor: vi.fn() };
  const host = createIndicator(
    document,
    {
      matchClass: overrides.matchClass ?? 'near',
      platform: overrides.platform ?? 'wykop',
      firstSeenAt: overrides.firstSeenAt ?? NOW - 2 * DAY_MS,
      permalink: WYKOP_PERMALINK,
      authorLabel: overrides.authorLabel === undefined ? '@alice' : overrides.authorLabel,
      nowMs: NOW,
    },
    actions,
  );
  document.body.append(host);
  return { host, root: shadowOf(host), actions };
}

describe('createIndicator (AC-051, AC-052, AC-059, AC-060)', () => {
  it('should render in a closed shadow root of a div[data-purefeed-ui] host', async () => {
    const { host } = await render();
    expect(host.tagName).toBe('DIV');
    expect(host.hasAttribute('data-purefeed-ui')).toBe(true);
    expect(shadowInits.get(host)?.mode).toBe('closed');
    expect(host.shadowRoot).toBeNull();
  });

  it('should say similar, the first platform and the relative time for a near duplicate seen on Wykop 2 days ago (TC-070)', async () => {
    const { root } = await render();
    expect(normalized(visibleText(root))).toContain('Hidden by PureFeed: similar, seen on Wykop 2 d ago');
  });

  it('should say exact for an exact duplicate first seen on Reddit', async () => {
    const { root } = await render({ matchClass: 'exact', platform: 'reddit', firstSeenAt: NOW - 5 * 60_000 });
    expect(normalized(visibleText(root))).toContain('Hidden by PureFeed: exact, seen on Reddit 5 min ago');
  });

  it('should name X as X', async () => {
    const { root } = await render({ platform: 'x', firstSeenAt: NOW - 3 * 3_600_000 });
    expect(normalized(visibleText(root))).toContain('seen on X 3 h ago');
  });

  it('should hold the 3 buttons Show, Always show this post and Always show <author> (TC-070)', async () => {
    const { root } = await render();
    expect(labelsOf(root)).toEqual(['Show', 'Always show this post', 'Always show @alice']);
  });

  it('should drop the author button if the post has no author', async () => {
    const { root } = await render({ authorLabel: null });
    expect(labelsOf(root)).toEqual(['Show', 'Always show this post']);
  });

  it('should render an author label as text, never as markup', async () => {
    const { root } = await render({ authorLabel: 'u/<img src=x onerror=alert(1)>' });
    expect(labelsOf(root)[2]).toBe('Always show u/<img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
  });

  it('should link seen on <Platform> to the first-seen permalink in a new tab (TC-071)', async () => {
    const { root } = await render();
    const links = [...root.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link.getAttribute('href')).toBe(WYKOP_PERMALINK);
    expect(link.getAttribute('target')).toBe('_blank');
    expect((link.getAttribute('rel') ?? '').split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    expect(normalized(link.textContent ?? '')).toContain('Wykop');
  });

  it('should call the matching action for each button click (TC-072, TC-073, TC-074)', async () => {
    const { root, actions } = await render();
    const [show, post, author] = buttonsOf(root);
    show.click();
    expect(actions.onShow).toHaveBeenCalledTimes(1);
    post.click();
    expect(actions.onAlwaysShowPost).toHaveBeenCalledTimes(1);
    author.click();
    expect(actions.onAlwaysShowAuthor).toHaveBeenCalledTimes(1);
  });

  it('should use native type=button buttons that stay in the tab order (TC-079)', async () => {
    const { root } = await render();
    for (const button of buttonsOf(root)) {
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button.getAttribute('type')).toBe('button');
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.disabled).toBe(false);
    }
  });

  it('should show a focus ring on keyboard focus (TC-079)', async () => {
    const { root } = await render();
    expect(cssOf(root)).toMatch(FOCUS_VISIBLE);
  });

  it('should reset inherited page CSS at the host and cap the height at 56 px (TC-080)', async () => {
    const { root } = await render();
    const css = cssOf(root);
    expect(css).toMatch(HOST_RESET);
    expect(css).toMatch(MAX_HEIGHT);
  });
});

describe('PLATFORM_LABEL', () => {
  it('should name the 3 platforms Reddit, Wykop and X', async () => {
    const { PLATFORM_LABEL } = await loadIndicator();
    expect(PLATFORM_LABEL).toEqual({ reddit: 'Reddit', wykop: 'Wykop', x: 'X' });
  });
});
