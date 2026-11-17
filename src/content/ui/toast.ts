import type { SetTimer } from '../../shared/types.ts';
import { attachUi, TOAST_CSS } from './styles.ts';

export type Toaster = { notifyHidden(): void };

const messageOf = (count: number) => `PureFeed hid ${count} duplicate${count === 1 ? '' : 's'}`;

export function createToaster(
  doc: Document,
  opts: { windowMs: number; visibleMs: number; setTimer: SetTimer; clearTimer: (id: unknown) => void },
): Toaster {
  let shown: { host: HTMLElement; live: HTMLElement } | null = null;
  let count = 0;
  let isWindowOpen = false;
  let closeTimer: unknown;

  const mount = () => {
    const { host, root } = attachUi(doc, TOAST_CSS);
    const live = doc.createElement('div');
    live.className = 'toast';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    root.append(live);
    doc.documentElement.append(host);
    return { host, live };
  };

  const close = () => {
    shown?.host.remove();
    shown = null;
  };

  return {
    notifyHidden() {
      if (!isWindowOpen) {
        count = 0;
        isWindowOpen = true;
        opts.setTimer(() => {
          isWindowOpen = false;
        }, opts.windowMs);
      }
      count++;
      shown ??= mount();
      shown.live.textContent = messageOf(count);
      opts.clearTimer(closeTimer);
      closeTimer = opts.setTimer(close, opts.visibleMs);
    },
  };
}
