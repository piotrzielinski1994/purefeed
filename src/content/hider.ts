const HIDDEN_ATTRIBUTE = 'data-purefeed-hidden';

const indicators = new WeakMap<Element, HTMLElement>();

export function hidePost(el: Element, indicator: HTMLElement): void {
  indicators.get(el)?.remove();
  indicators.set(el, indicator);
  el.setAttribute(HIDDEN_ATTRIBUTE, '');
  el.before(indicator);
}

export function revealPost(el: Element): void {
  indicators.get(el)?.remove();
  indicators.delete(el);
  el.removeAttribute(HIDDEN_ATTRIBUTE);
}

export const isHidden = (el: Element): boolean => el.hasAttribute(HIDDEN_ATTRIBUTE);
