export type FakeObserverHandle = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>;
export type FakeObserverFactory = (cb: IntersectionObserverCallback, init: IntersectionObserverInit) => FakeObserverHandle;

export type FakeIntersectionObserver = {
  init: IntersectionObserverInit;
  targets: Set<Element>;
  disconnected: boolean;
  callback: IntersectionObserverCallback;
  handle: FakeObserverHandle;
};

export type FakeObservers = {
  factory: FakeObserverFactory;
  observers: FakeIntersectionObserver[];
  lookaheadObservers(): FakeIntersectionObserver[];
  enterLookahead(...els: Element[]): void;
  leaveLookahead(...els: Element[]): void;
  setVisible(el: Element, ratio: number): void;
  isObserved(el: Element): boolean;
};

export type Rect = { top: number; left?: number; width: number; height: number };

export function setLayout(el: Element, rect: Rect): void {
  const left = rect.left ?? 0;
  const box = {
    x: left,
    y: rect.top,
    top: rect.top,
    left,
    width: rect.width,
    height: rect.height,
    right: left + rect.width,
    bottom: rect.top + rect.height,
  };
  Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ ...box, toJSON: () => box }) });
  for (const [key, value] of [
    ['offsetWidth', rect.width],
    ['offsetHeight', rect.height],
    ['clientWidth', rect.width],
    ['clientHeight', rect.height],
  ] as const) {
    Object.defineProperty(el, key, { configurable: true, get: () => value });
  }
}

const related = (target: Element, el: Element): boolean => target === el || target.contains(el) || el.contains(target);

const isLookahead = (o: FakeIntersectionObserver): boolean => String(o.init.rootMargin ?? '').includes('150%');

function entryOf(target: Element, ratio: number): IntersectionObserverEntry {
  const rect = target.getBoundingClientRect();
  return {
    target,
    isIntersecting: ratio > 0,
    intersectionRatio: ratio,
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
    time: 0,
  } as IntersectionObserverEntry;
}

export function createFakeObservers(): FakeObservers {
  const observers: FakeIntersectionObserver[] = [];
  const inLookahead = new Set<Element>();
  const visible = new Map<Element, number>();

  const stateOf = (o: FakeIntersectionObserver, target: Element): number => {
    if (isLookahead(o)) {
      return [...inLookahead].some((el) => related(target, el)) ? 1 : 0;
    }
    let ratio = 0;
    for (const [el, r] of visible) if (related(target, el)) ratio = Math.max(ratio, r);
    return ratio;
  };

  const notify = (o: FakeIntersectionObserver, targets: Element[]) => {
    if (o.disconnected || targets.length === 0) return;
    o.callback(
      targets.map((t) => entryOf(t, stateOf(o, t))),
      o.handle as IntersectionObserver,
    );
  };

  const factory: FakeObserverFactory = (callback, init) => {
    const o = { init: init ?? {}, targets: new Set<Element>(), disconnected: false, callback } as FakeIntersectionObserver;
    o.handle = {
      observe(el) {
        o.targets.add(el);
        queueMicrotask(() => {
          if (o.targets.has(el)) notify(o, [el]);
        });
      },
      unobserve(el) {
        o.targets.delete(el);
      },
      disconnect() {
        o.disconnected = true;
        o.targets.clear();
      },
    };
    observers.push(o);
    return o.handle;
  };

  const fire = (pick: (o: FakeIntersectionObserver) => boolean, els: Element[]) => {
    for (const o of observers) {
      if (o.disconnected || !pick(o)) continue;
      const targets: Element[] = [];
      for (const el of els) {
        for (const t of o.targets) if (related(t, el) && !targets.includes(t)) targets.push(t);
      }
      notify(o, targets);
    }
  };

  return {
    factory,
    observers,
    lookaheadObservers: () => observers.filter(isLookahead),
    enterLookahead(...els) {
      for (const el of els) inLookahead.add(el);
      fire(isLookahead, els);
    },
    leaveLookahead(...els) {
      for (const el of els) inLookahead.delete(el);
      fire(isLookahead, els);
    },
    setVisible(el, ratio) {
      visible.set(el, ratio);
      fire((o) => !isLookahead(o), [el]);
    },
    isObserved: (el) => observers.some((o) => !o.disconnected && [...o.targets].some((t) => related(t, el))),
  };
}
