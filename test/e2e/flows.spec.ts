import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { MEDIA_HOSTS, PLATFORM_HOSTS } from '../../src/shared/hosts.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import type { Platform } from '../../src/shared/types.ts';
import {
  catchAllHostRule,
  expect,
  extensionIdOf,
  hostResolverRules,
  launchExtension,
  sendFromPage,
  extensionTest as test,
} from './extension.ts';
import { FEED_URL, type FeedPost, feedPage, isBrowserServiceRequest, mediaUrl, serveHtml } from './feed-generator.ts';
import type { RequestLogEntry } from './server.ts';

type DomNode = {
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: Array<DomNode & { shadowRootType?: string }>;
};
type UiHost = {
  backendNodeId: number;
  contentBackendNodeId: number | null;
  liveRegionBackendNodeId: number | null;
  text: string;
  buttons: Array<{ name: string; backendNodeId: number }>;
  links: Array<{ text: string; href: string | null; target: string | null }>;
  beforePost: string | null;
};
type AxNode = {
  name?: { value?: string };
  role?: { value?: string };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
};

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();
const attrOf = (n: DomNode, name: string): string | null => {
  const a = n.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return null;
};
const kidsOf = (n: DomNode): DomNode[] => [...(n.shadowRoots ?? []), ...(n.children ?? [])];
const textOf = (n: DomNode): string =>
  n.nodeType === 3 ? n.nodeValue : ['STYLE', 'SCRIPT'].includes(n.nodeName) ? '' : kidsOf(n).map(textOf).join(' ');

async function purefeedUi(page: Page): Promise<UiHost[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const hosts: UiHost[] = [];
    const collect = (n: DomNode, host: UiHost) => {
      if (n.nodeName === 'BUTTON') host.buttons.push({ name: norm(textOf(n)), backendNodeId: n.backendNodeId });
      if (n.nodeName === 'A') host.links.push({ text: norm(textOf(n)), href: attrOf(n, 'href'), target: attrOf(n, 'target') });
      if (n.nodeType === 1 && host.liveRegionBackendNodeId === null && (attrOf(n, 'aria-live') !== null || attrOf(n, 'role') === 'status'))
        host.liveRegionBackendNodeId = n.backendNodeId;
      for (const c of kidsOf(n)) collect(c, host);
    };
    const walk = (n: DomNode) => {
      const kids = n.children ?? [];
      kids.forEach((c, i) => {
        const isUi =
          c.nodeType === 1 && (attrOf(c, 'data-purefeed-ui') !== null || (c.shadowRoots ?? []).some((r) => r.shadowRootType === 'closed'));
        if (!isUi) return;
        const next = kids.slice(i + 1).find((k) => k.nodeType === 1);
        const content = (c.shadowRoots ?? []).flatMap((r) => r.children ?? []).find((k) => k.nodeType === 1 && k.nodeName !== 'STYLE');
        const host: UiHost = {
          backendNodeId: c.backendNodeId,
          contentBackendNodeId: content?.backendNodeId ?? null,
          liveRegionBackendNodeId: null,
          text: norm(textOf(c)),
          buttons: [],
          links: [],
          beforePost: next ? attrOf(next, 'data-pf-index') : null,
        };
        for (const r of c.shadowRoots ?? []) collect(r, host);
        hosts.push(host);
      });
      for (const c of kidsOf(n)) walk(c);
    };
    walk(root);
    return hosts;
  } finally {
    await cdp.detach();
  }
}

const indicatorOf = async (page: Page, index: string): Promise<UiHost | undefined> =>
  (await purefeedUi(page)).find((h) => h.beforePost === index);
const toastOf = async (page: Page): Promise<UiHost | undefined> => (await purefeedUi(page)).find((h) => h.text.startsWith('PureFeed hid'));

async function boxOf(page: Page, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = (await cdp.send('DOM.getBoxModel', { backendNodeId })) as { model: { border: number[] } };
    const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
    const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } finally {
    await cdp.detach();
  }
}

async function clickUi(page: Page, host: UiHost | undefined, name: string | RegExp): Promise<void> {
  const button = host?.buttons.find((b) => (typeof name === 'string' ? b.name === name : name.test(b.name)));
  if (!button) throw new Error(`no PureFeed button ${name}; buttons: ${JSON.stringify(host?.buttons.map((b) => b.name))}`);
  const box = await boxOf(page, button.backendNodeId);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function focusedName(page: Page): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    const focused = nodes.filter((n) => n.properties?.some((p) => p.name === 'focused' && p.value.value === true));
    return focused.length > 0 ? norm(String(focused[focused.length - 1].name?.value ?? '')) : null;
  } finally {
    await cdp.detach();
  }
}

async function tabTo(page: Page, name: string, maxPresses = 80): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press('Tab');
    if ((await focusedName(page)) === name) return;
  }
  throw new Error(`Tab never reached a control named ${name}`);
}

const isHidden = (page: Page, index: string): Promise<boolean> =>
  page.locator(`[data-pf-index="${index}"]`).evaluate((el) => el.hasAttribute('data-purefeed-hidden'));
const hiddenCount = (page: Page): Promise<number> => page.locator('[data-purefeed-hidden]').count();
const stripExtension = (html: string): string => html.replace(/\s+data-purefeed-[\w-]+(="[^"]*")?/g, '');

async function openFeed(
  context: BrowserContext,
  platform: Platform,
  name: string,
  posts: FeedPost[],
  opts: Parameters<typeof feedPage>[2] = {},
  viewport?: { width: number; height: number },
) {
  const url = FEED_URL[platform](name);
  await serveHtml(url, feedPage(platform, posts, opts));
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(url);
  return page;
}

const imgPost = (platform: Platform, index: string, id: string, asset: string, author = `pf_${index}`): FeedPost => ({
  id,
  author,
  media: { kind: 'img', src: mediaUrl(platform, asset, index) },
  marks: { 'data-pf-index': index },
});
const videoEntry = (index: string, id: string, src: string, extra: { muted?: boolean } = {}): FeedPost => ({
  id,
  author: `pf_${index}`,
  media: { kind: 'video', src, ...extra },
  marks: { 'data-pf-index': index },
});

async function uniqueItems(extensionPage: Page): Promise<number> {
  return (await sendFromPage(extensionPage, { type: 'status/get' })).counters.uniqueItems;
}

async function storageLocal(extensionPage: Page, keys: string[] | null): Promise<Record<string, unknown>> {
  return extensionPage.evaluate(
    (k) =>
      (
        globalThis as unknown as { chrome: { storage: { local: { get(k: string[] | null): Promise<Record<string, unknown>> } } } }
      ).chrome.storage.local.get(k),
    keys,
  );
}

const extensionVideoTraffic = (log: RequestLogEntry[]) =>
  log.filter((e) => e.fromExtension && /\.(mp4|webm)$/.test(e.path.split('?')[0])).map((e) => ({ path: e.path, bytes: e.bytesSent }));

const VIDEO_PAGE_PROBE = `
(() => {
  const v = document.querySelector('video');
  v.volume = 0.5;
  window.__pfVideo = { events: [], times: [], at3: null };
  setTimeout(() => {
    for (const type of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'volumechange', 'emptied', 'abort', 'loadstart', 'ended'])
      v.addEventListener(type, () => window.__pfVideo.events.push({ type, t: v.currentTime }));
    v.addEventListener('timeupdate', () => {
      window.__pfVideo.times.push(v.currentTime);
      if (window.__pfVideo.at3 === null && v.currentTime >= 3) window.__pfVideo.at3 = { paused: v.paused, muted: v.muted, volume: v.volume };
    });
  }, 300);
})();
`;

test.describe('passive page video sampling in Chromium (AC-015, AC-017, AC-018, AC-019, AC-020, AC-021)', () => {
  test('should fingerprint a playing page video from 8 page frames with 0 extension bytes of the file and its state unchanged (TC-019, TC-026, TC-027)', async ({
    server,
  }) => {
    test.setTimeout(120_000);
    const profile = mkdtempSync(join(tmpdir(), 'purefeed-e2e-video-'));
    const context = await launchExtension(profile, hostResolverRules(server.port), {
      viewport: { width: 1280, height: 900 },
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await worker.evaluate(() => {
        type Frames = { type?: string; frames?: Array<{ tS: number }>; durationS?: number };
        const g = globalThis as unknown as {
          __pfFrames: Array<{ count: number; durationS: number; ts: number[] }>;
          chrome: { runtime: { onMessage: { addListener(l: (m: Frames) => void): void } } };
        };
        g.__pfFrames = [];
        g.chrome.runtime.onMessage.addListener((m) => {
          if (m?.type === 'media/frames')
            g.__pfFrames.push({ count: m.frames?.length ?? 0, durationS: m.durationS ?? 0, ts: (m.frames ?? []).map((f) => f.tS) });
        });
      });
      const page = await openFeed(
        context,
        'wykop',
        'video-big',
        [videoEntry('v1', '93000001', 'https://wykop.pl/cdn/c3201142/big.mp4', { muted: false })],
        {
          script: VIDEO_PAGE_PROBE,
        },
      );

      await expect
        .poll(() => worker.evaluate(() => (globalThis as unknown as { __pfFrames: unknown[] }).__pfFrames.length), { timeout: 60_000 })
        .toBeGreaterThan(0);
      const [frames] = await worker.evaluate(
        () => (globalThis as unknown as { __pfFrames: Array<{ count: number; durationS: number; ts: number[] }> }).__pfFrames,
      );
      expect(frames.count).toBe(8);
      expect(frames.durationS).toBeCloseTo(20, 0);
      expect(new Set(frames.ts).size).toBe(8);
      expect([...frames.ts].sort((a, b) => a - b)).toEqual(frames.ts);

      const probe = await page.evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement;
        const w = window as unknown as { __pfVideo: { events: Array<{ type: string; t: number }>; times: number[]; at3: unknown } };
        return { ...w.__pfVideo, now: { paused: v.paused, ended: v.ended, muted: v.muted, volume: v.volume, rate: v.playbackRate } };
      });
      const unexpected = probe.events.filter(
        (e, i) => !(e.type === 'ended' || (e.type === 'pause' && probe.events[i + 1]?.type === 'ended') || (e.type === 'play' && e.t < 1)),
      );
      expect(probe.at3).toEqual({ paused: false, muted: false, volume: 0.5 });
      expect(unexpected).toEqual([]);
      expect(probe.now).toMatchObject({ muted: false, volume: 0.5, rate: 1 });
      expect(probe.now.paused).toBe(probe.now.ended);
      expect(probe.times.every((t, i) => i === 0 || t >= probe.times[i - 1])).toBe(true);

      const big = server.log.filter((e) => e.path.split('?')[0].endsWith('/big.mp4'));
      expect(big.length).toBeGreaterThan(0);
      expect(big.filter((e) => e.fromExtension)).toEqual([]);
      expect(extensionVideoTraffic(server.log)).toEqual([]);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('should hide later posts whose page videos show the seen clip in VP9 or with an intro and keep an unrelated video visible (TC-022, TC-023, TC-025)', async ({
    context,
    extensionPage,
    server,
  }) => {
    test.setTimeout(180_000);
    const tall = { width: 1280, height: 1000 };
    const first = await openFeed(
      context,
      'wykop',
      'video-seen',
      [videoEntry('s1', '93000011', 'https://wykop.pl/cdn/c3201142/clip.mp4')],
      {},
      tall,
    );
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await first.close();

    const later = await openFeed(
      context,
      'wykop',
      'video-repost',
      [
        videoEntry('r1', '93000021', 'https://wykop.pl/cdn/c3201142/clip-360.webm'),
        videoEntry('r2', '93000022', 'https://wykop.pl/cdn/c3201142/clip-intro.mp4'),
        videoEntry('r3', '93000023', 'https://wykop.pl/cdn/c3201142/other.mp4'),
      ],
      {},
      tall,
    );
    await expect.poll(async () => [await isHidden(later, 'r1'), await isHidden(later, 'r2')], { timeout: 90_000 }).toEqual([true, true]);
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    expect(await isHidden(later, 'r3')).toBe(false);
    expect((await indicatorOf(later, 'r1'))?.text).toMatch(/Hidden by PureFeed: exact, seen on Wykop/);
    expect((await indicatorOf(later, 'r2'))?.text).toMatch(/Hidden by PureFeed: similar, seen on Wykop/);
    expect(extensionVideoTraffic(server.log)).toEqual([]);
  });
});

test.describe('cross-platform flows on local Wykop, Reddit and X feeds (AC-029, AC-036, AC-053, AC-070, TC-041, TC-050)', () => {
  test('should hide a meme seen on Wykop on Reddit and X with a seen on Wykop indicator, reveal it on Show and keep it hidden after a browser restart', async ({
    server,
  }) => {
    test.setTimeout(180_000);
    const profile = mkdtempSync(join(tmpdir(), 'purefeed-e2e-profile-'));
    const served: string[] = [];
    const open = async (context: BrowserContext, platform: Platform, name: string, posts: FeedPost[]) => {
      served.push(feedPage(platform, posts));
      return openFeed(context, platform, name, posts);
    };
    const wykopPosts = [imgPost('wykop', 'w1', '92000001', 'base.png')];
    const redditPosts = [imgPost('reddit', 'r1', 'pfx1', 'base-50.png'), imgPost('reddit', 'r2', 'pfx2', 'other-1.png')];
    const xPosts = [imgPost('x', 'x1', '1870000000000000901', 'base-q60.jpg')];
    let context = await launchExtension(profile, catchAllHostRule(server.port));
    try {
      let id = await extensionIdOf(context);
      let ext = await context.newPage();
      await ext.goto(`chrome-extension://${id}/options.html`);

      const wykop = await open(context, 'wykop', 'meme', wykopPosts);
      await expect.poll(() => uniqueItems(ext), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      expect(await isHidden(wykop, 'w1')).toBe(false);

      const reddit = await open(context, 'reddit', 'meme', redditPosts);
      await expect.poll(() => isHidden(reddit, 'r1'), { timeout: 30_000 }).toBe(true);
      expect((await indicatorOf(reddit, 'r1'))?.text).toMatch(/^Hidden by PureFeed: exact, seen on Wykop\b/);
      await expect.poll(() => server.log.some((e) => e.fromExtension && e.path.startsWith('/other-1.png')), { timeout: 30_000 }).toBe(true);
      await reddit.waitForTimeout(1_500);
      expect(await isHidden(reddit, 'r2')).toBe(false);

      const x = await open(context, 'x', 'meme', xPosts);
      await expect.poll(() => isHidden(x, 'x1'), { timeout: 30_000 }).toBe(true);
      expect((await indicatorOf(x, 'x1'))?.text).toMatch(/^Hidden by PureFeed: (exact|similar), seen on Wykop\b/);
      await clickUi(x, await indicatorOf(x, 'x1'), 'Show');
      await expect.poll(() => isHidden(x, 'x1'), { timeout: 1_000 }).toBe(false);
      expect(await indicatorOf(x, 'x1')).toBeUndefined();
      for (const feed of [wykop, reddit, x]) await feed.close();

      const settings = { ...DEFAULT_SETTINGS, toast: false, retentionDays: 90 };
      await ext.evaluate(
        (s) =>
          (globalThis as unknown as { chrome: { storage: { local: { set(i: unknown): Promise<void> } } } }).chrome.storage.local.set({
            settings: s,
          }),
        settings,
      );
      await sendFromPage(ext, { type: 'whitelist/add', entry: { type: 'source', key: 'reddit:r/pf_keep' } });
      await ext.waitForTimeout(2_500);
      const before = {
        storage: await storageLocal(ext, ['settings', 'whitelist']),
        counters: (await sendFromPage(ext, { type: 'status/get' })).counters,
      };
      expect(before.storage.settings).toEqual(settings);
      await context.close();

      context = await launchExtension(profile, catchAllHostRule(server.port));
      id = await extensionIdOf(context);
      ext = await context.newPage();
      await ext.goto(`chrome-extension://${id}/options.html`);
      expect((await sendFromPage(ext, { type: 'status/get' })).counters).toEqual(before.counters);
      expect(await storageLocal(ext, ['settings', 'whitelist'])).toEqual(before.storage);
      const again = await open(context, 'reddit', 'meme-after-restart', redditPosts);
      await expect.poll(() => isHidden(again, 'r1'), { timeout: 30_000 }).toBe(true);
      expect((await indicatorOf(again, 'r1'))?.text).toMatch(/seen on Wykop/);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }

    const allowed = new Set<string>([...PLATFORM_HOSTS, ...MEDIA_HOSTS]);
    const pageHosts = new Set(served.flatMap((html) => [...html.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1])));
    expect(
      [...new Set(server.log.filter((e) => !isBrowserServiceRequest(e)).map((e) => e.host))].filter(
        (h) => !allowed.has(h) && !pageHosts.has(h),
      ),
    ).toEqual([]);
    const pageMedia = new Set(served.flatMap((html) => [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))));
    const fromExtension = server.log.filter((e) => e.fromExtension && !isBrowserServiceRequest(e));
    expect(fromExtension.length).toBeGreaterThan(0);
    expect(fromExtension.filter((e) => !MEDIA_HOSTS.includes(e.host as (typeof MEDIA_HOSTS)[number]) || e.hasBody)).toEqual([]);
    expect(fromExtension.map((e) => `https://${e.host}${e.path}`).filter((u) => !pageMedia.has(u))).toEqual([]);
  });

  test('should keep the hidden post and its descendants in the DOM and restore its markup on Show (TC-069)', async ({ context }) => {
    const page = await openFeed(
      context,
      'reddit',
      'tc069',
      [imgPost('reddit', 'o', 'pf69a', 'base.png'), imgPost('reddit', 'd', 'pf69b', 'base-50.png')],
      {
        script: `window.__pfBefore = Object.fromEntries([...document.querySelectorAll('[data-pf-index]')].map((el) => [el.dataset.pfIndex, { html: el.outerHTML, nodes: el.querySelectorAll('*').length }]));`,
      },
    );
    await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
    const before = await page.evaluate(
      () => (window as unknown as { __pfBefore: Record<string, { html: string; nodes: number }> }).__pfBefore.d,
    );
    const hidden = await page
      .locator('[data-pf-index="d"]')
      .evaluate((el) => ({ connected: el.isConnected, nodes: el.querySelectorAll('*').length }));
    expect(hidden).toEqual({ connected: true, nodes: before.nodes });
    await clickUi(page, await indicatorOf(page, 'd'), 'Show');
    await expect.poll(() => isHidden(page, 'd'), { timeout: 1_000 }).toBe(false);
    expect(stripExtension(await page.locator('[data-pf-index="d"]').evaluate((el) => el.outerHTML))).toBe(before.html);
  });

  test('should reach the indicator buttons with Tab, show a focus ring, act on Enter and Space and run no animation under reduced motion (TC-079)', async ({
    context,
    extensionPage,
  }) => {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const cdp = await context.newCDPSession(page);
    const animations: string[] = [];
    cdp.on('Animation.animationStarted', (e: { animation: { name?: string; type?: string } }) =>
      animations.push(`${e.animation.type}:${e.animation.name}`),
    );
    await cdp.send('Animation.enable');
    const url = FEED_URL.reddit('tc079');
    await serveHtml(
      url,
      feedPage('reddit', [
        imgPost('reddit', 'o', 'pf79a', 'base.png'),
        imgPost('reddit', 'd1', 'pf79b', 'base-50.png'),
        imgPost('reddit', 'd2', 'pf79c', 'base.webp'),
      ]),
    );
    await page.goto(url);
    await expect.poll(async () => [await isHidden(page, 'd1'), await isHidden(page, 'd2')], { timeout: 30_000 }).toEqual([true, true]);
    const host = page.locator('[data-pf-index="d1"]').locator('xpath=preceding-sibling::*[1]');
    const unfocused = await host.screenshot();

    await tabTo(page, 'Show');
    expect((await host.screenshot()).equals(unfocused)).toBe(false);
    await page.keyboard.press('Enter');
    await expect.poll(() => isHidden(page, 'd1'), { timeout: 1_000 }).toBe(false);
    expect(await isHidden(page, 'd2')).toBe(true);

    await tabTo(page, 'Always show this post');
    await page.keyboard.press('Space');
    await expect.poll(() => isHidden(page, 'd2'), { timeout: 1_000 }).toBe(false);
    await expect
      .poll(async () => JSON.stringify((await storageLocal(extensionPage, ['whitelist'])).whitelist ?? []), { timeout: 3_000 })
      .toContain('reddit:t3_pf79c');
    expect(animations).toEqual([]);
    await cdp.detach();
  });

  test('should render the indicator and the toast the same on a page whose CSS hides buttons and enlarges fonts (TC-080)', async ({
    context,
  }) => {
    const shots: Record<'plain' | 'hostile', { indicator: Buffer; toast: Buffer; size: { width: number; height: number } }> = {} as never;
    for (const variant of ['plain', 'hostile'] as const) {
      const page = await openFeed(
        context,
        'reddit',
        `tc080-${variant}`,
        [imgPost('reddit', 'o', `pf80${variant[0]}a`, 'base.png'), imgPost('reddit', 'd', `pf80${variant[0]}b`, 'base-50.png', 'pf_tc080')],
        {
          css: variant === 'hostile' ? 'button { display: none } * { font-size: 40px }' : '',
        },
      );
      await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
      const toast = await toastOf(page);
      const toastId = toast?.liveRegionBackendNodeId ?? toast?.contentBackendNodeId;
      if (!toastId) throw new Error(`no toast on the ${variant} page`);
      const toastShot = await page.screenshot({ clip: await boxOf(page, toastId) });
      const indicator = await indicatorOf(page, 'd');
      if (!indicator?.contentBackendNodeId) throw new Error(`no indicator on the ${variant} page`);
      const box = await boxOf(page, indicator.contentBackendNodeId);
      shots[variant] = { indicator: await page.screenshot({ clip: box }), toast: toastShot, size: { width: box.width, height: box.height } };
      expect(indicator.buttons.map((b) => b.name)).toEqual([
        'Show',
        'Always show this post',
        expect.stringMatching(/^Always show \S*pf_tc080$/),
      ]);
      await page.close();
    }
    expect(shots.hostile.size).toEqual(shots.plain.size);
    expect(shots.hostile.indicator.equals(shots.plain.indicator)).toBe(true);
    expect(shots.hostile.toast.equals(shots.plain.toast)).toBe(true);
  });
});

type Box = { left: number; top: number; right: number; bottom: number };
type IndicatorLayout = { bar: Box; textLines: number; buttons: Array<{ name: string; box: Box }> };

async function indicatorLayout(page: Page, barBackendNodeId: number): Promise<IndicatorLayout> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: barBackendNodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const text = this.querySelector('.text');
        const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
        return {
          bar: box(this),
          textLines: Math.round(text.getBoundingClientRect().height / lineHeight),
          buttons: [...this.querySelectorAll('button')].map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent, box: box(b) })),
        };
      }`,
    })) as { result: { value: IndicatorLayout } };
    return result.value;
  } finally {
    await cdp.detach();
  }
}

const isInside = (inner: Box, outer: Box): boolean =>
  inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom && inner.right > inner.left;

test.describe('hide indicator layout (AC-051, TC-070)', () => {
  for (const width of [null, 384, 320]) {
    test(`should keep the indicator within 56 px and 2 text lines with every button inside the bar at ${width ?? 'default'} px`, async ({
      context,
    }) => {
      const page = await openFeed(
        context,
        'reddit',
        `tc070-${width ?? 'default'}`,
        [
          imgPost('reddit', 'o', `pf70${width ?? 0}a`, 'base.png'),
          imgPost('reddit', 'd', `pf70${width ?? 0}b`, 'base-50.png', 'pf_tc070_author'),
        ],
        { css: width === null ? '' : `body { width: ${width}px; }` },
      );
      await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
      const indicator = await indicatorOf(page, 'd');
      if (!indicator?.contentBackendNodeId) throw new Error('no indicator');
      const layout = await indicatorLayout(page, indicator.contentBackendNodeId);
      expect(layout.bar.bottom - layout.bar.top).toBeLessThanOrEqual(56);
      expect(layout.textLines).toBeLessThanOrEqual(2);
      expect(layout.buttons.map((b) => b.name)).toEqual(['Show', 'Always show this post', 'Always show u/pf_tc070_author']);
      expect(layout.buttons.filter((b) => !isInside(b.box, layout.bar)).map((b) => b.name)).toEqual([]);
      expect(new Set(layout.buttons.map((b) => Math.round(b.box.top))).size).toBe(1);
    });
  }
});

test.describe('popup toggles in open tabs (AC-063, AC-065, TC-083, TC-085)', () => {
  const MASTER = /purefeed|deduplication|enable/i;

  async function openTwoTabs(context: BrowserContext) {
    const reddit = await openFeed(context, 'reddit', 'popup', [
      imgPost('reddit', 'o', 'pf83a', 'base.png'),
      imgPost('reddit', 'd', 'pf83b', 'base-50.png'),
    ]);
    const wykop = await openFeed(context, 'wykop', 'popup', [
      imgPost('wykop', 'o', '92000083', 'other-2.png'),
      imgPost('wykop', 'd', '92000084', 'other-2.png'),
    ]);
    await expect.poll(async () => [await isHidden(reddit, 'd'), await isHidden(wykop, 'd')], { timeout: 30_000 }).toEqual([true, true]);
    return { reddit, wykop };
  }

  async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    return popup;
  }

  const toggle = (popup: Page, name: RegExp) => popup.getByRole('checkbox', { name }).or(popup.getByRole('switch', { name })).first();

  test('should reveal every hidden post in 2 tabs within 1 s if the master toggle goes off and hide them again within 1 s if it goes on (TC-083)', async ({
    context,
    extensionId,
  }) => {
    const { reddit, wykop } = await openTwoTabs(context);
    const popup = await openPopup(context, extensionId);
    await toggle(popup, MASTER).click();
    await expect.poll(async () => (await hiddenCount(reddit)) + (await hiddenCount(wykop)), { timeout: 1_000, intervals: [50] }).toBe(0);
    await toggle(popup, MASTER).click();
    await expect
      .poll(async () => [await isHidden(reddit, 'd'), await isHidden(wykop, 'd')], { timeout: 1_000, intervals: [50] })
      .toEqual([true, true]);
  });

  test('should reveal hidden Reddit posts within 1 s if the Reddit toggle goes off and keep the Wykop tab unchanged (TC-085)', async ({
    context,
    extensionId,
  }) => {
    const { reddit, wykop } = await openTwoTabs(context);
    const popup = await openPopup(context, extensionId);
    await toggle(popup, /^reddit\b/i).click();
    await expect.poll(() => hiddenCount(reddit), { timeout: 1_000, intervals: [50] }).toBe(0);
    await reddit.waitForTimeout(1_000);
    expect(await isHidden(wykop, 'd')).toBe(true);
    expect(await hiddenCount(reddit)).toBe(0);
  });
});

test.describe('seen recording on the local fixture feeds (AC-032, AC-061)', () => {
  for (const platform of ['reddit', 'wykop', 'x'] as const) {
    test(`should count a visible unique ${platform} image as 1 unique item within 30 s`, async ({ context, extensionPage }) => {
      const page = await openFeed(context, platform, 'seen', [
        imgPost(platform, 's1', platform === 'reddit' ? 'pfs1' : '1870000000000000951', 'other-1.png'),
      ]);
      await expect.poll(() => uniqueItems(extensionPage), { timeout: 30_000 }).toBe(1);
      expect(await isHidden(page, 's1')).toBe(false);
    });
  }
});
