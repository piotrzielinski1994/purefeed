// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeClock } from '../../../test/helpers/fake-ext.ts';

const loadToast = () => import('./toast.ts');

const REDUCED_MOTION = /prefers-reduced-motion:\s*reduce/;
const FIXED = /position:\s*fixed/;
const BOTTOM = /bottom:/;
const RIGHT = /right:/;
const HOST_RESET = /:host\s*\{[^}]*all:\s*initial/;

const shadowRoots = new WeakMap<Element, ShadowRoot>();
const originalAttachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, init);
    shadowRoots.set(this, root);
    return root;
  };
});

afterEach(() => {
  Element.prototype.attachShadow = originalAttachShadow;
  for (const el of document.querySelectorAll('*')) if (shadowRoots.has(el)) el.remove();
  document.body.replaceChildren();
});

function cssOf(root: ShadowRoot): string {
  const tags = [...root.querySelectorAll('style')].map((s) => s.textContent ?? '');
  const sheets = (root.adoptedStyleSheets ?? []).flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText));
  return [...tags, ...sheets].join('\n');
}

function textOf(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== 'STYLE') out += textOf(child);
  }
  return out.replace(/\s+/g, ' ').trim();
}

const toastHosts = () => [...document.querySelectorAll('*')].filter((host) => shadowRoots.has(host));
const toastTexts = () => toastHosts().map((host) => textOf(shadowRoots.get(host) as ShadowRoot));

async function setup() {
  const { createToaster } = await loadToast();
  const clock = createFakeClock();
  const toaster = createToaster(document, { windowMs: 3000, visibleMs: 4000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { toaster, clock };
}

describe('createToaster (AC-057, AC-058, AC-059, AC-060)', () => {
  it('should show one toast that counts 3 hides within 2 s (TC-077)', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    await clock.advance(1000);
    toaster.notifyHidden();
    await clock.advance(1000);
    toaster.notifyHidden();
    await clock.advance(10);
    expect(toastTexts()).toEqual(['PureFeed hid 3 duplicates']);
  });

  it('should use the singular for 1 hide', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    await clock.advance(10);
    expect(toastTexts()).toEqual(['PureFeed hid 1 duplicate']);
  });

  it('should close the toast after 4 s (TC-077)', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    await clock.advance(1000);
    toaster.notifyHidden();
    await clock.advance(1000);
    toaster.notifyHidden();
    await clock.advance(1990);
    expect(toastTexts()).toHaveLength(1);
    await clock.advance(4020);
    expect(toastTexts()).toEqual([]);
  });

  it('should start a new count if a hide comes after the toast closed', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    toaster.notifyHidden();
    await clock.advance(8000);
    toaster.notifyHidden();
    await clock.advance(10);
    expect(toastTexts()).toEqual(['PureFeed hid 1 duplicate']);
  });

  it('should never take focus (TC-077)', async () => {
    const { toaster, clock } = await setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    toaster.notifyHidden();
    await clock.advance(10);
    toaster.notifyHidden();
    await clock.advance(5000);
    expect(document.activeElement).toBe(input);
  });

  it('should announce the count through aria-live polite', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    await clock.advance(10);
    const [host] = toastHosts();
    const root = shadowRoots.get(host) as ShadowRoot;
    const live = root.querySelector('[aria-live]') ?? (host.hasAttribute('aria-live') ? host : null);
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(textOf(live as Node)).toBe('PureFeed hid 1 duplicate');
  });

  it('should sit fixed in the bottom-right corner, reset page CSS and turn animation off under reduced motion (TC-079, TC-080)', async () => {
    const { toaster, clock } = await setup();
    toaster.notifyHidden();
    await clock.advance(10);
    const css = cssOf(shadowRoots.get(toastHosts()[0]) as ShadowRoot);
    expect(css).toMatch(FIXED);
    expect(css).toMatch(BOTTOM);
    expect(css).toMatch(RIGHT);
    expect(css).toMatch(REDUCED_MOTION);
    expect(css).toMatch(HOST_RESET);
  });
});
