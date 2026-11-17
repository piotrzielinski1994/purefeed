import type { SetTimer } from '../shared/types.ts';

export type ObserverFactory = (
  cb: IntersectionObserverCallback,
  init: IntersectionObserverInit,
) => Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>;

export type SeenTracker = { track(el: Element): void; untrack(el: Element): void };

const SEEN_RATIO = 0.5;

export function createSeenTracker(opts: {
  createObserver: ObserverFactory;
  dwellMs: number;
  setTimer: SetTimer;
  clearTimer: (id: unknown) => void;
  onSeen: (el: Element) => void;
}): SeenTracker {
  const timers = new Map<Element, unknown>();

  const stopTimer = (el: Element) => {
    if (timers.has(el)) {
      opts.clearTimer(timers.get(el));
      timers.delete(el);
    }
  };

  const untrack = (el: Element) => {
    stopTimer(el);
    observer.unobserve(el);
  };

  const onEntry = (entry: IntersectionObserverEntry) => {
    const el = entry.target;
    if (!entry.isIntersecting || entry.intersectionRatio < SEEN_RATIO) {
      stopTimer(el);
      return;
    }
    if (timers.has(el)) {
      return;
    }
    timers.set(
      el,
      opts.setTimer(() => {
        untrack(el);
        opts.onSeen(el);
      }, opts.dwellMs),
    );
  };

  const observer = opts.createObserver(
    (entries) => {
      entries.forEach(onEntry);
    },
    { threshold: SEEN_RATIO },
  );

  return {
    track(el) {
      observer.observe(el);
    },
    untrack,
  };
}
