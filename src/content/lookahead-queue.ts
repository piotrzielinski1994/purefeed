export type LookaheadQueue<J> = { push(job: J): void; running(): number; size(): number };

export function createLookaheadQueue<J>(opts: {
  concurrency: number;
  priority: (job: J) => number;
  run: (job: J) => Promise<void>;
}): LookaheadQueue<J> {
  const waiting: J[] = [];
  let active = 0;

  const takeNearest = (): J => {
    const index = waiting.reduce((best, job, i) => (opts.priority(job) < opts.priority(waiting[best]) ? i : best), 0);
    return waiting.splice(index, 1)[0];
  };

  const pump = () => {
    while (active < opts.concurrency && waiting.length > 0) {
      const job = takeNearest();
      active++;
      Promise.resolve()
        .then(() => opts.run(job))
        .catch(() => undefined)
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    push(job) {
      waiting.push(job);
      queueMicrotask(pump);
    },
    running: () => active,
    size: () => waiting.length,
  };
}
