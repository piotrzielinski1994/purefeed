import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLayout } from './fake-observers.ts';

export const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

const BODY = /<body[^>]*>([\s\S]*)<\/body>/i;
const PX = (style: string, prop: string): number | null => {
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(style);
  return match ? Number(match[1]) : null;
};

export const fixtureHtml = (relPath: string): string => readFileSync(join(FIXTURES_DIR, relPath), 'utf8');

export function fixtureBody(relPath: string): string {
  const html = fixtureHtml(relPath);
  const match = BODY.exec(html);
  if (!match) throw new Error(`fixture ${relPath} has no <body>`);
  return match[1];
}

const elementsOf = (root: ParentNode): Element[] => [...root.querySelectorAll('*')];

// happy-dom does not parse declarative shadow DOM; a browser attaches it while parsing the fixture page.
export function attachDeclarativeShadowRoots(root: ParentNode): void {
  for (const template of elementsOf(root).filter((el) => el.tagName === 'TEMPLATE' && el.hasAttribute('shadowrootmode'))) {
    const host = template.parentElement;
    if (!host) continue;
    const mode = template.getAttribute('shadowrootmode') === 'closed' ? 'closed' : 'open';
    const shadow = host.attachShadow({ mode });
    shadow.append((template as HTMLTemplateElement).content.cloneNode(true));
    template.remove();
    attachDeclarativeShadowRoots(shadow);
  }
}

export function applyStyleLayout(root: ParentNode): void {
  let top = 0;
  const visit = (scope: ParentNode) => {
    for (const el of elementsOf(scope)) {
      const style = el.getAttribute('style') ?? '';
      const width = PX(style, 'width');
      const height = PX(style, 'height');
      if (width !== null && height !== null) {
        setLayout(el, { top, width, height });
        top += height;
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
}

export function loadFixture(doc: Document, relPath: string): HTMLElement {
  doc.body.innerHTML = fixtureBody(relPath);
  attachDeclarativeShadowRoots(doc.body);
  applyStyleLayout(doc.body);
  return doc.body;
}

export function fragment(doc: Document, html: string): Element {
  const holder = doc.createElement('div');
  holder.innerHTML = html.trim();
  attachDeclarativeShadowRoots(holder);
  applyStyleLayout(holder);
  const el = holder.firstElementChild;
  if (!el) throw new Error('fragment has no element');
  return el;
}

export const setUrl = (url: string): void => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

export const mediaEls = (root: ParentNode): Element[] => {
  const out: Element[] = [];
  for (const el of elementsOf(root)) {
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') out.push(el);
    if (el.shadowRoot) out.push(...mediaEls(el.shadowRoot));
  }
  return out;
};

export const byId = (doc: Document, id: string): Element => {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`fixture element #${id} not found`);
  return el;
};

export const bySrc = (root: ParentNode, src: string): HTMLImageElement | HTMLVideoElement => {
  const el = mediaEls(root).find((m) => m.getAttribute('src') === src || m.getAttribute('srcset')?.split(' ')[0] === src);
  if (!el) throw new Error(`fixture media ${src} not found`);
  return el as HTMLImageElement | HTMLVideoElement;
};
