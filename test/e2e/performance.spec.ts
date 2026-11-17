import type { BrowserContext, Page } from '@playwright/test';
import type { Platform } from '../../src/shared/types.ts';
import { expect, extensionTest as test } from './extension.ts';
import { FEED_URL, feedPage, feedPosts, generateFeed, scrollFeed, serveHtml } from './feed-generator.ts';

type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid?: number; tid?: number; args?: { data?: { url?: string } } };

const LONG_TASK_MS = 50;
const STARTUP_BUDGET_MS = 15;
const LOOKAHEAD_VIEWPORTS = 1.5;
const VIEWPORT = { width: 1280, height: 900 };

function extensionTaskDurations(trace: TraceEvent[], extensionId: string): number[] {
  const prefix = `chrome-extension://${extensionId}/`;
  return trace
    .filter((e) => e.ph === 'X' && typeof e.dur === 'number' && (e.args?.data?.url ?? '').startsWith(prefix))
    .map((e) => (e.dur as number) / 1000);
}

const msOf = (e: TraceEvent): number => (e.dur ?? 0) / 1000;

function contentStartup(trace: TraceEvent[], extensionId: string): { evaluateMs: number; startMicrotasksMs: number[] } {
  const prefix = `chrome-extension://${extensionId}/`;
  const evaluate = trace.find((e) => e.name === 'EvaluateScript' && e.ph === 'X' && e.args?.data?.url === `${prefix}content.js`);
  if (!evaluate) throw new Error('no EvaluateScript event of content.js in the trace');
  const evaluatedAt = evaluate.ts + (evaluate.dur ?? 0);
  const mainThread = trace.filter((e) => e.ph === 'X' && e.pid === evaluate.pid && e.tid === evaluate.tid && e.ts >= evaluatedAt);
  const firstCallback = mainThread
    .filter((e) => e.name === 'FunctionCall' && (e.args?.data?.url ?? '').startsWith(prefix))
    .reduce<TraceEvent | null>((first, e) => (first === null || e.ts < first.ts ? e : first), null);
  if (!firstCallback) throw new Error('no extension callback after content.js evaluation');
  const startMicrotasksMs = mainThread.filter((e) => e.name === 'RunMicrotasks' && e.ts + (e.dur ?? 0) <= firstCallback.ts).map(msOf);
  return { evaluateMs: msOf(evaluate), startMicrotasksMs };
}

const TOP_LEVEL_SLICES = new Set(['ThreadControllerImpl::RunTask', 'BlinkScheduler_PerformMicrotaskCheckpoint']);
const SAME_TASK_GAP_US = 100;

function pageTasksWithExtensionWork(trace: TraceEvent[], extensionId: string): { tasksMs: number[]; contentThread: string } {
  const prefix = `chrome-extension://${extensionId}/`;
  const content = trace.find((e) => e.ph === 'X' && e.name === 'FunctionCall' && e.args?.data?.url === `${prefix}content.js`);
  if (!content) throw new Error('no content.js callback in the trace');
  const onThread = trace.filter((e) => e.ph === 'X' && e.pid === content.pid && e.tid === content.tid);
  const end = (e: TraceEvent): number => e.ts + (e.dur ?? 0);
  const slices = onThread.filter((e) => TOP_LEVEL_SLICES.has(e.name)).sort((a, b) => a.ts - b.ts || end(b) - end(a));
  const tasks = slices.reduce<Array<{ ts: number; end: number }>>((acc, slice) => {
    const last = acc.at(-1);
    if (last && slice.ts < last.end) {
      return acc;
    }
    if (last && slice.name === 'BlinkScheduler_PerformMicrotaskCheckpoint' && slice.ts - last.end < SAME_TASK_GAP_US) {
      return [...acc.slice(0, -1), { ts: last.ts, end: end(slice) }];
    }
    return [...acc, { ts: slice.ts, end: end(slice) }];
  }, []);
  const work = onThread.filter((e) => (e.args?.data?.url ?? '').startsWith(prefix) || e.name === 'RunMicrotasks');
  const tasksMs = tasks.filter((t) => work.some((e) => e.ts >= t.ts && e.ts < t.end)).map((t) => (t.end - t.ts) / 1000);
  return { tasksMs, contentThread: `${content.pid}:${content.tid}` };
}

async function traced<T>(
  context: BrowserContext,
  page: Page,
  run: () => Promise<T>,
  categories = 'devtools.timeline,v8.execute',
): Promise<{ result: T; trace: TraceEvent[] }> {
  const cdp = await context.newCDPSession(page);
  const trace: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (payload) => trace.push(...(payload.value as unknown as TraceEvent[])));
  await cdp.send('Tracing.start', { categories, transferMode: 'ReportEvents' });
  try {
    const result = await run();
    return { result, trace };
  } finally {
    const complete = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await complete;
    await cdp.detach();
  }
}

const DUPLICATE_PROBE = `
(() => {
  const dups = (window.__pfDup = {});
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const r = dups[e.target.getAttribute('data-pf-index')];
        if (r && r.halfAt === undefined && e.intersectionRatio >= 0.5 && !e.target.hasAttribute('data-purefeed-hidden')) r.halfAt = performance.now();
      }
    },
    { threshold: [0.5] },
  );
  const track = (el) => {
    const index = el.getAttribute('data-pf-index');
    if (dups[index]) return;
    dups[index] = {};
    io.observe(el);
  };
  new MutationObserver((records) => {
    for (const m of records) {
      if (m.type === 'attributes') {
        const r = dups[m.target.getAttribute('data-pf-index')];
        if (r && r.hiddenAt === undefined && m.target.hasAttribute('data-purefeed-hidden')) r.hiddenAt = performance.now();
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('[data-pf-dup]')) track(n);
        for (const el of n.querySelectorAll('[data-pf-dup]')) track(el);
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-purefeed-hidden'] });
})();
`;

async function openGeneratedFeed(context: BrowserContext, platform: Platform, name: string, init?: string): Promise<Page> {
  const url = FEED_URL[platform](name);
  await serveHtml(url, generateFeed({ platform, posts: 300, duplicates: 30 }));
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);
  if (init) await page.addInitScript(init);
  return page;
}

test.describe('performance on 300-post fixture feeds (AC-074, AC-075, AC-077)', () => {
  test('should start the content script within 15 ms and request no media of posts below the 1.5 viewport lookahead (TC-097)', async ({
    context,
    extensionId,
    server,
  }) => {
    const page = await openGeneratedFeed(context, 'reddit', 'tc097');
    const { trace } = await traced(context, page, async () => {
      await page.goto(FEED_URL.reddit('tc097'));
      await page.waitForTimeout(4_000);
    });
    const startup = extensionTaskDurations(
      trace.filter((e) => e.name === 'EvaluateScript'),
      extensionId,
    );
    expect(startup.length).toBeGreaterThan(0);
    expect(startup.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(STARTUP_BUDGET_MS);

    const requested = server.log
      .filter((e) => e.fromExtension)
      .map((e) => new URL(`https://${e.host}${e.path}`).searchParams.get('pf'))
      .filter((pf): pf is string => pf !== null);
    expect(requested.length).toBeGreaterThan(0);
    const below = await page.evaluate(
      ([indices, viewports]) =>
        indices
          .map((i) => ({
            i,
            top: (document.querySelector(`[data-pf-index="${i}"]`)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) + scrollY,
          }))
          .filter((p) => p.top >= innerHeight * (1 + viewports)),
      [requested, LOOKAHEAD_VIEWPORTS] as const,
    );
    expect(below).toEqual([]);
  });

  test('should spend <= 15 ms main-thread time from content script evaluation through runtime start after the storage reads (TC-097)', async ({
    context,
    extensionId,
  }) => {
    const page = await openGeneratedFeed(context, 'reddit', 'tc097-start');
    const { trace } = await traced(context, page, async () => {
      await page.goto(FEED_URL.reddit('tc097-start'));
      await page.waitForTimeout(3_000);
    });
    const { evaluateMs, startMicrotasksMs } = contentStartup(trace, extensionId);
    expect(startMicrotasksMs.length).toBeGreaterThan(0);
    expect(evaluateMs + startMicrotasksMs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
  });

  test('should run no page main-thread task over 50 ms that holds extension work and hash pixels on another thread while a 300-post Wykop feed with playing videos scrolls (TC-098)', async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(300_000);
    const VIDEO_EVERY = 20;
    const posts = feedPosts({ platform: 'wykop', posts: 300, duplicates: 30 }).map((post, i) =>
      post.media === null && i % VIDEO_EVERY === 5
        ? { ...post, media: { kind: 'video' as const, src: `https://wykop.pl/cdn/c3201142/clip.mp4?pf=v${i}` } }
        : post,
    );
    expect(posts.filter((p) => p.media?.kind === 'video').length).toBeGreaterThanOrEqual(10);
    const url = FEED_URL.wykop('perf-video');
    await serveHtml(url, feedPage('wykop', posts, { title: 'Fixture: wykop generated feed with videos', initial: 20 }));
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);
    const { trace } = await traced(
      context,
      page,
      async () => {
        await page.goto(url);
        await page.waitForTimeout(1_500);
        await scrollFeed(page, 500);
        await page.waitForTimeout(2_000);
      },
      'devtools.timeline,v8.execute,toplevel',
    );
    const played = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.currentTime > 0).length);
    expect(played).toBeGreaterThan(0);
    const { tasksMs, contentThread } = pageTasksWithExtensionWork(trace, extensionId);
    expect(tasksMs.length).toBeGreaterThan(0);
    expect(tasksMs.filter((ms) => ms > LONG_TASK_MS).map((ms) => Math.round(ms))).toEqual([]);
    const hashing = trace.filter(
      (e) => e.ph === 'X' && e.name === 'FunctionCall' && e.args?.data?.url === `chrome-extension://${extensionId}/hash-worker.js`,
    );
    expect(hashing.length).toBeGreaterThan(0);
    expect(hashing.filter((e) => `${e.pid}:${e.tid}` === contentThread)).toEqual([]);
  });

  for (const platform of ['reddit', 'wykop', 'x'] as const) {
    test(`should run no extension task over 50 ms and hide each of 30 duplicates before half of it is visible while a 300-post ${platform} feed scrolls (TC-098, TC-100)`, async ({
      context,
      extensionId,
    }) => {
      test.setTimeout(300_000);
      const page = await openGeneratedFeed(context, platform, `perf-${platform}`, DUPLICATE_PROBE);
      await page.goto(FEED_URL[platform](`perf-${platform}`));
      await page.waitForTimeout(1_500);
      const { trace } = await traced(context, page, async () => {
        await scrollFeed(page, 500);
        await page.waitForTimeout(2_000);
      });
      const feed = await page.evaluate(() => (window as unknown as { __pfFeed: { total: number; appended: number } }).__pfFeed);
      expect(feed).toEqual({ total: 300, appended: 300 });

      const durations = extensionTaskDurations(trace, extensionId);
      expect(durations.length).toBeGreaterThan(0);
      expect(durations.filter((ms) => ms > LONG_TASK_MS).map((ms) => Math.round(ms))).toEqual([]);

      const dups = await page.evaluate(
        () => (window as unknown as { __pfDup: Record<string, { hiddenAt?: number; halfAt?: number }> }).__pfDup,
      );
      expect(Object.keys(dups)).toHaveLength(30);
      const late = Object.entries(dups)
        .filter(([, r]) => r.hiddenAt === undefined || r.halfAt !== undefined)
        .map(([index, r]) => ({ index, ...r }));
      expect(late).toEqual([]);
    });
  }
});
