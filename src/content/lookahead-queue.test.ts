import { describe, expect, it } from 'vitest';
import { settle } from '../../test/helpers/fake-ext.ts';

const loadQueue = () => import('./lookahead-queue.ts');

type Job = { name: string; distance: number };

async function harness(concurrency = 4) {
  const { createLookaheadQueue } = await loadQueue();
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let running = 0;
  let peak = 0;
  const queue = createLookaheadQueue<Job>({
    concurrency,
    priority: (job) => job.distance,
    run: (job) =>
      new Promise<void>((resolve, reject) => {
        started.push(job.name);
        running++;
        peak = Math.max(peak, running);
        const done = () => running--;
        pending.set(job.name, {
          resolve: () => {
            done();
            resolve();
          },
          reject: (e) => {
            done();
            reject(e);
          },
        });
      }),
  });
  const finish = async (name: string) => {
    pending.get(name)?.resolve();
    await settle();
  };
  return { queue, started, pending, finish, peak: () => peak };
}

const jobs = (n: number, from = 0): Job[] => Array.from({ length: n }, (_, i) => ({ name: `j${from + i}`, distance: (from + i) * 100 }));

describe('createLookaheadQueue (AC-076)', () => {
  it('should run at most 4 jobs at the same time if 20 jobs are pushed (TC-099)', async () => {
    const { queue, started, finish, peak } = await harness();
    for (const job of jobs(20)) queue.push(job);
    await settle();
    expect(queue.running()).toBe(4);
    expect(queue.size()).toBe(16);
    for (let i = 0; i < 20; i++) await finish(started[i]);
    expect(started).toHaveLength(20);
    expect(peak()).toBe(4);
    expect(queue.running()).toBe(0);
    expect(queue.size()).toBe(0);
  });

  it('should start the next queued job if a running job finishes', async () => {
    const { queue, started, finish } = await harness();
    for (const job of jobs(6)) queue.push(job);
    await settle();
    expect(started).toHaveLength(4);
    await finish(started[0]);
    expect(started).toHaveLength(5);
    expect(queue.running()).toBe(4);
  });

  it('should start queued jobs nearest to the viewport first (lowest priority value) (TC-099)', async () => {
    const { queue, started, finish } = await harness();
    for (const job of jobs(4)) queue.push(job);
    await settle();
    queue.push({ name: 'far', distance: 5000 });
    queue.push({ name: 'near', distance: 50 });
    queue.push({ name: 'middle', distance: 900 });
    await settle();
    await finish('j0');
    await finish('j1');
    await finish('j2');
    expect(started.slice(4)).toEqual(['near', 'middle', 'far']);
  });

  it('should read the priority when a slot frees, so a job that scrolled nearer starts first', async () => {
    const { queue, started, finish } = await harness(1);
    queue.push({ name: 'blocker', distance: 0 });
    await settle();
    const a = { name: 'a', distance: 100 };
    const b = { name: 'b', distance: 200 };
    queue.push(a);
    queue.push(b);
    b.distance = 10;
    await finish('blocker');
    expect(started).toEqual(['blocker', 'b']);
  });

  it('should free the slot of a job that fails', async () => {
    const { queue, started, pending } = await harness(1);
    queue.push({ name: 'fails', distance: 0 });
    queue.push({ name: 'next', distance: 1 });
    await settle();
    pending.get('fails')?.reject(new Error('decode failed'));
    await settle();
    expect(started).toEqual(['fails', 'next']);
    expect(queue.running()).toBe(1);
  });
});
