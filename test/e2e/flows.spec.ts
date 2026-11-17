import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
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
  stopServiceWorkers,
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
const videoEntry = (index: string, id: string, src: string, extra: { muted?: boolean; loop?: boolean; poster?: string } = {}): FeedPost => ({
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

  test('should hide the VP9 360p copy of a seen H.264 720p clip as exact, the clip with an outro as similar and the MP4 of a seen GIF (TC-021, TC-022, TC-024)', async ({
    context,
    extensionPage,
    server,
  }) => {
    test.setTimeout(240_000);
    const tall = { width: 1280, height: 1000 };
    const first = await openFeed(
      context,
      'wykop',
      'video-seen-720',
      [videoEntry('s1', '93000031', 'https://wykop.pl/cdn/c3201142/clip-720.mp4'), imgPost('wykop', 's2', '93000032', 'loop.gif')],
      {},
      tall,
    );
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 60_000 }).toBe(2);
    await first.close();

    const later = await openFeed(
      context,
      'wykop',
      'video-repost-720',
      [
        videoEntry('r1', '93000041', 'https://wykop.pl/cdn/c3201142/clip-360.webm'),
        videoEntry('r2', '93000042', 'https://wykop.pl/cdn/c3201142/clip-outro.mp4'),
        videoEntry('r3', '93000043', 'https://wykop.pl/cdn/c3201142/loop.mp4', { loop: true }),
      ],
      {},
      tall,
    );
    await expect
      .poll(async () => [await isHidden(later, 'r1'), await isHidden(later, 'r2'), await isHidden(later, 'r3')], { timeout: 120_000 })
      .toEqual([true, true, true]);
    expect((await indicatorOf(later, 'r1'))?.text).toMatch(/Hidden by PureFeed: exact, seen on Wykop/);
    expect((await indicatorOf(later, 'r2'))?.text).toMatch(/Hidden by PureFeed: similar, seen on Wykop/);
    expect(extensionVideoTraffic(server.log)).toEqual([]);
  });
});

type FramesMessage = { count: number; posterUrl: string | null; at: number };

async function recordFramesMessages(worker: Worker): Promise<() => Promise<FramesMessage[]>> {
  await worker.evaluate(() => {
    type Frames = { type?: string; frames?: unknown[]; posterUrl?: string | null };
    const g = globalThis as unknown as {
      __pfFramesAt: FramesMessage[];
      chrome: { runtime: { onMessage: { addListener(l: (m: Frames) => void): void } } };
    };
    g.__pfFramesAt = [];
    g.chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'media/frames') g.__pfFramesAt.push({ count: m.frames?.length ?? 0, posterUrl: m.posterUrl ?? null, at: Date.now() });
    });
  });
  return () => worker.evaluate(() => (globalThis as unknown as { __pfFramesAt: FramesMessage[] }).__pfFramesAt);
}

test.describe('unreadable page video frames in Chromium (AC-022)', () => {
  test('should give a cross-origin page video without pixel access a poster-only fingerprint and hide another such video with the same poster (TC-028)', async ({
    context,
    serviceWorker,
    extensionPage,
    server,
  }) => {
    test.setTimeout(120_000);
    const frames = await recordFramesMessages(serviceWorker);
    const poster = 'https://wykop.pl/cdn/c3201142/base.png?pf=tc028-poster';
    const first = await openFeed(context, 'wykop', 'tc028-seen', [
      videoEntry('t1', '93000051', 'https://video.twimg.com/redirect-nocors/clip.mp4?pf=tc028a', { poster }),
    ]);
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 60_000 }).toBe(1);
    const loadedAt = await first.evaluate(() => performance.timeOrigin);
    const received = await frames();
    expect(received).toEqual([{ count: 0, posterUrl: poster, at: expect.any(Number) }]);
    expect(received[0].at - loadedAt).toBeLessThan(10_000);
    expect(
      await first.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
        context.drawImage(video, 0, 0);
        try {
          context.getImageData(0, 0, 1, 1);
          return `readable ${video.readyState}`;
        } catch (error) {
          return `${(error as DOMException).name} ${video.readyState}`;
        }
      }),
    ).toMatch(/^SecurityError [234]$/);
    const pageVideo = server.log.filter(
      (e) => e.path.startsWith('/redirect-nocors/clip.mp4') || (e.host === 'media2.test' && e.path === '/clip.mp4'),
    );
    expect(pageVideo.map((e) => [e.host, e.fromExtension])).toEqual(
      expect.arrayContaining([
        ['video.twimg.com', false],
        ['media2.test', false],
      ]),
    );
    expect(pageVideo.every((e) => !e.fromExtension)).toBe(true);
    await first.close();

    const later = await openFeed(context, 'wykop', 'tc028-repost', [
      videoEntry('t2', '93000052', 'https://video.twimg.com/redirect-nocors/other.mp4?pf=tc028b', { poster }),
    ]);
    await expect.poll(() => isHidden(later, 't2'), { timeout: 60_000 }).toBe(true);
    expect((await indicatorOf(later, 't2'))?.text).toMatch(/^Hidden by PureFeed: exact, seen on Wykop/);
    expect(extensionVideoTraffic(server.log)).toEqual([]);
  });

  test('should skip a stalled page video without a poster 10 s after load and hide neither of 2 posts carrying it (TC-029)', async ({
    context,
    serviceWorker,
    extensionPage,
    server,
  }) => {
    test.setTimeout(120_000);
    const frames = await recordFramesMessages(serviceWorker);
    const stalled = 'https://wykop.pl/stall/clip.mp4?pf=tc029';
    const page = await openFeed(context, 'wykop', 'tc029', [videoEntry('s1', '93000061', stalled), videoEntry('s2', '93000062', stalled)]);
    const loadedAt = await page.evaluate(() => performance.timeOrigin);
    await expect.poll(async () => (await frames()).length, { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(1_500);
    const received = await frames();
    expect(received.map((m) => [m.count, m.posterUrl])).toEqual([[0, null]]);
    received.forEach((m) => {
      expect(m.at - loadedAt).toBeGreaterThanOrEqual(10_000);
      expect(m.at - loadedAt).toBeLessThan(20_000);
    });
    await page.waitForTimeout(1_500);
    expect([await isHidden(page, 's1'), await isHidden(page, 's2')]).toEqual([false, false]);
    expect(await uniqueItems(extensionPage)).toBe(0);
    const stallRequests = server.log.filter((e) => e.path.startsWith('/stall/clip.mp4'));
    expect(stallRequests.length).toBeGreaterThan(0);
    expect(stallRequests.filter((e) => e.fromExtension)).toEqual([]);
  });
});

test.describe('cross-origin image URL the extension uses (AC-012)', () => {
  test('should fingerprint a cross-origin image from the currentSrc the page picked from srcset and request only that URL (TC-016)', async ({
    context,
    serviceWorker,
    extensionPage,
    server,
  }) => {
    await serviceWorker.evaluate(() => {
      type Message = { type?: string; req?: { url?: string } };
      const g = globalThis as unknown as {
        __pfUrls: string[];
        chrome: { runtime: { onMessage: { addListener(l: (m: Message) => void): void } } };
      };
      g.__pfUrls = [];
      g.chrome.runtime.onMessage.addListener((m) => {
        if (m?.type === 'media/fingerprint') g.__pfUrls.push(m.req?.url ?? '');
      });
    });
    const url = FEED_URL.x('tc016');
    const html = feedPage('x', [imgPost('x', 'c1', '1870000000000000016', 'base.png')]);
    expect(html).toContain(' 2x"');
    await serveHtml(url, html.replace(' 2x"', ' 1x"'));
    const page = await context.newPage();
    await page.goto(url);
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 30_000 }).toBe(1);
    const photo = await page
      .locator('[data-pf-index="c1"] img[alt="Image"]')
      .evaluate((img: HTMLImageElement) => ({ currentSrc: img.currentSrc, src: img.src }));
    expect(photo.currentSrc).toMatch(/^https:\/\/pbs\.twimg\.com\/media\/base\.png\?.*name=large/);
    expect(photo.src).toMatch(/name=small/);
    expect(await serviceWorker.evaluate(() => (globalThis as unknown as { __pfUrls: string[] }).__pfUrls)).toEqual([photo.currentSrc]);
    const used = new URL(photo.currentSrc);
    expect(server.log.filter((e) => e.fromExtension).map((e) => ({ host: e.host, path: e.path, hasBody: e.hasBody }))).toEqual([
      { host: used.host, path: `${used.pathname}${used.search}`, hasBody: false },
    ]);
  });
});

async function idbRecords(page: Page): Promise<Array<{ db: string; store: string; keys: string[] }>> {
  return page.evaluate(async () => {
    const request = <T>(r: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const out: Array<{ db: string; store: string; keys: string[] }> = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await request(indexedDB.open(info.name));
      for (const store of [...db.objectStoreNames]) {
        const values = await request(db.transaction(store).objectStore(store).getAll());
        for (const value of values) out.push({ db: info.name, store, keys: Object.keys(value as object).sort() });
      }
      db.close();
    }
    return out;
  });
}

test.describe('seen record storage location (AC-035)', () => {
  test('should store 1 record with exactly the 8 fields in the extension IndexedDB and nothing in the Reddit page origin (TC-049)', async ({
    context,
    extensionPage,
  }) => {
    const page = await openFeed(context, 'reddit', 'tc049', [imgPost('reddit', 'a', 'pf49a', 'base.png')]);
    await expect.poll(async () => (await idbRecords(extensionPage)).length, { timeout: 30_000 }).toBe(1);
    expect(await idbRecords(extensionPage)).toEqual([
      {
        db: 'purefeed',
        store: 'seen',
        keys: ['contentType', 'fingerprint', 'firstSeenAt', 'firstSeenPermalink', 'firstSeenPostKey', 'lastSeenAt', 'platform', 'seenCount'],
      },
    ]);
    expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  });
});

test.describe('stopped service worker (AC-007)', () => {
  test('should hide a fixture post with seen image A in the page after the service worker is stopped (TC-007)', async ({
    context,
    extensionPage,
  }) => {
    test.setTimeout(120_000);
    const seen = await openFeed(context, 'reddit', 'tc007-seen', [imgPost('reddit', 'a', 'pf7a', 'base.png')]);
    await expect.poll(() => uniqueItems(extensionPage), { timeout: 30_000 }).toBe(1);
    await seen.close();
    await extensionPage.waitForTimeout(2_500);
    await stopServiceWorkers(context, extensionPage);

    const page = await openFeed(context, 'reddit', 'tc007-after-stop', [
      imgPost('reddit', 'n', 'pf7n', 'other-1.png'),
      imgPost('reddit', 'r', 'pf7r', 'base-50.png'),
    ]);
    await expect.poll(() => isHidden(page, 'r'), { timeout: 30_000 }).toBe(true);
    expect(await isHidden(page, 'n')).toBe(false);
    expect((await indicatorOf(page, 'r'))?.text).toMatch(/^Hidden by PureFeed: exact, seen on Reddit/);
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

const UI_STYLE_PROPS = [
  'display',
  'visibility',
  'position',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'border-top-width',
  'border-bottom-width',
  'padding-top',
  'padding-left',
  'margin-top',
  'margin-left',
  'opacity',
];

type UiNodeSnapshot = { tag: string; text: string; box: number[] | null; style: Record<string, string> };

async function uiSnapshot(page: Page, hostBackendNodeId: number): Promise<UiNodeSnapshot[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode & { nodeId: number } };
    type Node = DomNode & { nodeId: number };
    const find = (n: Node): Node | null =>
      n.backendNodeId === hostBackendNodeId ? n : (kidsOf(n) as Node[]).reduce<Node | null>((hit, c) => hit ?? find(c), null);
    const host = find(root);
    if (!host) throw new Error('UI host not found');
    const hostBox = ((await cdp.send('DOM.getBoxModel', { nodeId: host.nodeId })) as { model: { border: number[] } }).model.border;
    const elements = (n: Node): Node[] => (kidsOf(n) as Node[]).flatMap((c) => [...(c.nodeType === 1 ? [c] : []), ...elements(c)]);
    const snapshot: UiNodeSnapshot[] = [];
    for (const el of elements(host).filter((e) => !['STYLE', 'SCRIPT'].includes(e.nodeName))) {
      const box = await cdp
        .send('DOM.getBoxModel', { nodeId: el.nodeId })
        .then((r) => (r as { model: { border: number[] } }).model.border.map((v, k) => Math.round((v - hostBox[k % 2]) * 100) / 100))
        .catch(() => null);
      const { computedStyle } = (await cdp.send('CSS.getComputedStyleForNode', { nodeId: el.nodeId })) as {
        computedStyle: Array<{ name: string; value: string }>;
      };
      snapshot.push({
        tag: el.nodeName,
        text: norm(textOf(el)),
        box,
        style: Object.fromEntries(computedStyle.filter((p) => UI_STYLE_PROPS.includes(p.name)).map((p) => [p.name, p.value])),
      });
    }
    return snapshot;
  } finally {
    await cdp.detach();
  }
}

test.describe('page CSS isolation on Wykop and X (AC-060)', () => {
  const IDS: Record<'wykop' | 'x', [string, string, string, string]> = {
    wykop: ['93000801', '93000802', '93000811', '93000812'],
    x: ['1870000000000000801', '1870000000000000802', '1870000000000000811', '1870000000000000812'],
  };
  for (const platform of ['wykop', 'x'] as const) {
    test(`should lay out and style every node of the indicator and the toast the same on a ${platform} page whose CSS hides buttons and enlarges fonts (TC-080)`, async ({
      context,
    }) => {
      const views: Partial<Record<'plain' | 'hostile', { indicator: UiNodeSnapshot[]; toast: UiNodeSnapshot[]; pageButton: string }>> = {};
      for (const [i, variant] of (['plain', 'hostile'] as const).entries()) {
        const [original, repost] = IDS[platform].slice(i * 2, i * 2 + 2);
        const page = await openFeed(
          context,
          platform,
          `tc080-${variant}`,
          [imgPost(platform, 'o', original, 'base.png'), imgPost(platform, 'd', repost, 'base-50.png', 'pf_tc080')],
          { css: variant === 'hostile' ? 'button { display: none } * { font-size: 40px }' : '' },
        );
        await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
        const toast = await toastOf(page);
        const indicator = await indicatorOf(page, 'd');
        if (!toast || !indicator) throw new Error(`no toast or indicator on the ${variant} ${platform} page`);
        expect(indicator.buttons.map((b) => b.name)).toEqual(['Show', 'Always show this post', 'Always show @pf_tc080']);
        views[variant] = {
          indicator: await uiSnapshot(page, indicator.backendNodeId),
          toast: await uiSnapshot(page, toast.backendNodeId),
          pageButton: await page.evaluate(() => {
            const button = document.body.appendChild(document.createElement('button'));
            return `${getComputedStyle(button).display} ${getComputedStyle(button).fontSize}`;
          }),
        };
        await page.close();
      }
      expect([views.plain?.pageButton, views.hostile?.pageButton]).toEqual([expect.not.stringMatching(/^none /), 'none 40px']);
      expect(views.plain?.indicator.length).toBeGreaterThan(5);
      expect(views.plain?.indicator.filter((n) => n.tag === 'BUTTON' && n.box !== null)).toHaveLength(3);
      expect(views.hostile?.indicator).toEqual(views.plain?.indicator);
      expect(views.hostile?.toast).toEqual(views.plain?.toast);
    });
  }
});

test.describe('toast resolved layout (AC-057, TC-077)', () => {
  test('should place the toast fixed 16 px from the bottom and right viewport edges and keep the page focus', async ({ context }) => {
    const page = await openFeed(
      context,
      'reddit',
      'toast-layout',
      [imgPost('reddit', 'o', 'pf57a', 'base.png'), imgPost('reddit', 'd', 'pf57b', 'base-50.png')],
      {
        script: `const input = document.createElement('input'); input.id = 'pf-focus'; document.body.prepend(input); input.focus();`,
      },
    );
    await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
    const toast = await toastOf(page);
    if (!toast?.contentBackendNodeId) throw new Error('no toast');
    const cdp = await context.newCDPSession(page);
    const layout = async () => {
      const border = async (backendNodeId: number) =>
        ((await cdp.send('DOM.getBoxModel', { backendNodeId })) as { model: { border: number[] } }).model.border;
      const [host, content] = [await border(toast.backendNodeId), await border(toast.contentBackendNodeId as number)];
      return { host, content };
    };
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [toast.backendNodeId] })) as {
      nodeIds: number[];
    };
    const { computedStyle } = (await cdp.send('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] })) as {
      computedStyle: Array<{ name: string; value: string }>;
    };
    const style = Object.fromEntries(
      computedStyle.filter((p) => ['position', 'right', 'bottom'].includes(p.name)).map((p) => [p.name, p.value]),
    );
    const viewport = page.viewportSize() as { width: number; height: number };
    const before = await layout();
    const [, , right, , , bottom] = before.host;
    await page.evaluate(() => scrollBy(0, 300));
    await page.waitForTimeout(200);
    const after = await layout();
    await cdp.detach();
    expect(style).toEqual({ position: 'fixed', right: '16px', bottom: '16px' });
    expect([viewport.width - right, viewport.height - bottom]).toEqual([16, 16]);
    expect(after).toEqual(before);
    expect(before.content[0]).toBeGreaterThan(viewport.width / 2);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pf-focus');
  });
});

type Box = { left: number; top: number; right: number; bottom: number };
type IndicatorLayout = {
  bar: Box;
  actions: Box;
  barClipped: boolean;
  text: { visible: string; lines: number; cut: string[] };
  buttons: Array<{ visible: string; label: string | null; title: string | null; box: Box; cut: string[] }>;
};

async function indicatorLayout(page: Page, barBackendNodeId: number): Promise<IndicatorLayout> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: barBackendNodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const norm = (s) => s.replace(/\\s+/g, ' ').trim();
        const cut = (el) => [el, ...el.querySelectorAll('*')]
          .filter((n) => n.getClientRects().length > 0 && n.scrollWidth > n.clientWidth)
          .map((n) => n.className || n.tagName);
        const text = this.querySelector('.text');
        const range = document.createRange();
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        const tops = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width > 0) tops.push(r.top);
        }
        const half = parseFloat(getComputedStyle(text).lineHeight) / 2;
        const lines = tops.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > half).length;
        return {
          bar: box(this),
          actions: box(this.querySelector('.actions')),
          barClipped: this.scrollHeight > this.clientHeight || this.scrollWidth > this.clientWidth,
          text: { visible: norm(text.innerText), lines, cut: [...cut(text), ...(text.scrollHeight > text.clientHeight ? ['text-height'] : [])] },
          buttons: [...this.querySelectorAll('button')].map((b) => ({
            visible: norm(b.innerText),
            label: b.getAttribute('aria-label'),
            title: b.getAttribute('title'),
            box: box(b),
            cut: cut(b),
          })),
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
  const LAYOUT_IDS: Record<Platform, [string, string]> = {
    reddit: ['pf70a', 'pf70b'],
    wykop: ['93000701', '93000702'],
    x: ['1870000000000000701', '1870000000000000702'],
  };
  const AUTHOR_PREFIX: Record<Platform, string> = { reddit: 'u/', wykop: '@', x: '@' };
  const STATUS: Record<Platform, RegExp> = {
    reddit: /^Hidden by PureFeed: (exact|similar), seen on Reddit (just now|\d+ (min|h|d) ago)$/,
    wykop: /^Hidden by PureFeed: (exact|similar), seen on Wykop (just now|\d+ (min|h|d) ago)$/,
    x: /^Hidden by PureFeed: (exact|similar), seen on X (just now|\d+ (min|h|d) ago)$/,
  };

  async function hiddenLayout(context: BrowserContext, platform: Platform, width: number | null, author: string) {
    const [first, repost] = LAYOUT_IDS[platform];
    const page = await openFeed(
      context,
      platform,
      `tc070-${width ?? 'default'}-${author.length}`,
      [imgPost(platform, 'o', first, 'base.png'), imgPost(platform, 'd', repost, 'base-50.png', author)],
      { css: width === null ? '' : `body { width: ${width}px; }` },
    );
    await expect.poll(() => isHidden(page, 'd'), { timeout: 30_000 }).toBe(true);
    const indicator = await indicatorOf(page, 'd');
    if (!indicator?.contentBackendNodeId) throw new Error('no indicator');
    return { page, layout: await indicatorLayout(page, indicator.contentBackendNodeId) };
  }

  const expectFitting = (layout: IndicatorLayout, platform: Platform) => {
    expect(layout.bar.bottom - layout.bar.top).toBeLessThanOrEqual(56);
    expect(layout.barClipped).toBe(false);
    expect(layout.text.visible).toMatch(STATUS[platform]);
    expect(layout.text.cut).toEqual([]);
    expect(layout.text.lines).toBeGreaterThanOrEqual(1);
    expect(layout.text.lines).toBeLessThanOrEqual(2);
    expect(layout.buttons.filter((b) => !isInside(b.box, layout.bar) || !isInside(b.box, layout.actions)).map((b) => b.visible)).toEqual([]);
    expect(new Set(layout.buttons.map((b) => Math.round(b.box.top))).size).toBe(1);
  };

  for (const platform of ['reddit', 'wykop', 'x'] as const) {
    const author = `${AUTHOR_PREFIX[platform]}pf_tc070_author`;
    for (const width of [null, 600, 481, 480, 400, 360]) {
      test(`should show the full status text and full button labels uncut within 56 px on ${platform} at ${width ?? 'default'} px`, async ({
        context,
      }) => {
        const { layout } = await hiddenLayout(context, platform, width, 'pf_tc070_author');
        expectFitting(layout, platform);
        expect(layout.buttons.map((b) => b.visible)).toEqual(['Show', 'Always show this post', `Always show ${author}`]);
        expect(layout.buttons.map((b) => b.label)).toEqual(['Show', 'Always show this post', `Always show ${author}`]);
        expect(layout.buttons.flatMap((b) => b.cut)).toEqual([]);
        if (width === null || width > 480) expect(layout.text.lines).toBe(1);
      });
    }

    test(`should keep the full status text and every button fully visible in the compact fallback on ${platform} at 320 px`, async ({
      context,
    }) => {
      const { layout } = await hiddenLayout(context, platform, 320, 'pf_tc070_author');
      expectFitting(layout, platform);
      expect(layout.buttons.map((b) => b.visible)).toEqual(['Show', 'this post', author]);
      expect(layout.buttons.map((b) => b.label)).toEqual(['Show', 'Always show this post', `Always show ${author}`]);
      expect(layout.buttons.flatMap((b) => b.cut)).toEqual([]);
    });
  }

  for (const width of [600, 360]) {
    test(`should shorten only a long author name with an ellipsis and keep the full name in aria-label and title at ${width} px`, async ({
      context,
    }) => {
      const long = 'pf_tc070_long_author_name_abcdefghijkl';
      const { layout } = await hiddenLayout(context, 'reddit', width, long);
      expectFitting(layout, 'reddit');
      const [show, post, authorButton] = layout.buttons;
      expect([show.visible, post.visible]).toEqual(['Show', 'Always show this post']);
      expect([...show.cut, ...post.cut]).toEqual([]);
      expect(authorButton.visible).toMatch(/^Always show u\/pf_tc070/);
      expect(authorButton.cut).toEqual(['name']);
      expect([authorButton.label, authorButton.title]).toEqual([`Always show u/${long}`, `Always show u/${long}`]);
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
