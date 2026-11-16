import type { SetTimer } from './types.ts';

export function throttle(run: () => void, deps: { now: () => number; setTimer: SetTimer; intervalMs: number }): () => void {
  let isScheduled = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  return () => {
    if (isScheduled) {
      return;
    }
    isScheduled = true;
    deps.setTimer(
      () => {
        isScheduled = false;
        lastRunAt = deps.now();
        run();
      },
      Math.max(0, lastRunAt + deps.intervalMs - deps.now()),
    );
  };
}
