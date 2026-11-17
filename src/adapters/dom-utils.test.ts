// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { setLayout } from '../../test/helpers/fake-observers.ts';

const loadDomUtils = () => import('./dom-utils.ts');

afterEach(() => {
  document.body.replaceChildren();
});

function sized(tag: string, width: number, height: number): Element {
  const el = document.createElement(tag);
  setLayout(el, { top: 0, width, height });
  document.body.append(el);
  return el;
}

describe('dom utils (AC-009, TC-010)', () => {
  it('should report the rendered CSS px size of an element', async () => {
    const { renderedSize } = await loadDomUtils();
    expect(renderedSize(sized('img', 320, 180))).toEqual({ width: 320, height: 180 });
  });

  it('should count only images and videos rendered at >= 150 x 150 CSS px as media items (TC-010)', async () => {
    const { isMediaItem } = await loadDomUtils();
    expect(isMediaItem(sized('img', 150, 150))).toBe(true);
    expect(isMediaItem(sized('video', 640, 360))).toBe(true);
    expect(isMediaItem(sized('img', 149, 149))).toBe(false);
    expect(isMediaItem(sized('img', 150, 149))).toBe(false);
    expect(isMediaItem(sized('video', 149, 400))).toBe(false);
    expect(isMediaItem(sized('div', 600, 600))).toBe(false);
  });
});
