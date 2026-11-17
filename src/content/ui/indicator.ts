import type { Platform } from '../../shared/types.ts';
import { formatRelative } from './relative-time.ts';
import { attachUi, INDICATOR_CSS } from './styles.ts';

export const PLATFORM_LABEL: Record<Platform, string> = { reddit: 'Reddit', wykop: 'Wykop', x: 'X' };

const MATCH_LABEL = { exact: 'exact', near: 'similar' } as const;
const ALWAYS_SHOW = 'Always show';

export type IndicatorData = {
  matchClass: 'exact' | 'near';
  platform: Platform;
  firstSeenAt: number;
  permalink: string;
  authorLabel: string | null;
  nowMs: number;
};

export type IndicatorActions = { onShow(): void; onAlwaysShowPost(): void; onAlwaysShowAuthor(): void };

export function createIndicator(doc: Document, data: IndicatorData, actions: IndicatorActions): HTMLElement {
  const { host, root } = attachUi(doc, INDICATOR_CSS);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  };
  const button = (className: string, prefix: string, label: string, onClick: () => void): HTMLButtonElement => {
    const el = element('button', className);
    el.type = 'button';
    el.setAttribute('aria-label', prefix === '' ? label : `${prefix} ${label}`);
    el.append(...(prefix === '' ? [label] : [element('span', 'prefix', prefix), ' ', element('span', 'name', label)]));
    el.addEventListener('click', onClick);
    return el;
  };

  const link = element('a', 'source', `seen on ${PLATFORM_LABEL[data.platform]}`);
  link.href = data.permalink;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const text = element('p', 'text');
  text.append(`Hidden by PureFeed: ${MATCH_LABEL[data.matchClass]}, `, link, ` ${formatRelative(data.firstSeenAt, data.nowMs)}`);

  const actionsRow = element('div', 'actions');
  actionsRow.append(button('action', '', 'Show', actions.onShow), button('action', ALWAYS_SHOW, 'this post', actions.onAlwaysShowPost));
  if (data.authorLabel !== null) {
    const author = button('action author', ALWAYS_SHOW, data.authorLabel, actions.onAlwaysShowAuthor);
    author.title = `${ALWAYS_SHOW} ${data.authorLabel}`;
    actionsRow.append(author);
  }
  const bar = element('div', 'bar');
  bar.append(text, actionsRow);
  root.append(bar);
  return host;
}
