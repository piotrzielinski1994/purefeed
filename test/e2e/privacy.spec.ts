import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_HOSTS, PLATFORM_HOSTS } from '../../src/shared/hosts.ts';
import type { Platform } from '../../src/shared/types.ts';
import { catchAllHostRule, expect, extensionIdOf, launchExtension, sendFromPage, extensionTest as test } from './extension.ts';
import { FEED_URL, feedPage, feedPosts, isBrowserServiceRequest, scrollFeed, serveHtml } from './feed-generator.ts';

type Described = string | number | boolean | null | { typedArray: string; bytes: number } | Described[] | { [key: string]: Described };
type StoredValue = { db: string; store: string; value: Described };

const RECORD_FIELDS = [
  'contentType',
  'fingerprint',
  'firstSeenAt',
  'firstSeenPermalink',
  'firstSeenPostKey',
  'lastSeenAt',
  'platform',
  'seenCount',
];
const FINGERPRINT_FIELDS = new Set(['kind', 'hash', 'crops', 'edges', 'frames', 'timestamps', 'durationS']);
const MAX_FINGERPRINT_BYTES = 1024;

const isTyped = (v: Described): v is { typedArray: string; bytes: number } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'typedArray' in v;

function strings(v: Described, skip: Set<string> = new Set()): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap((x) => strings(x, skip));
  if (v === null || typeof v !== 'object' || isTyped(v)) return [];
  return Object.entries(v)
    .filter(([k]) => !skip.has(k))
    .flatMap(([, x]) => strings(x, skip));
}

test.describe('privacy on local Wykop, Reddit and X feeds (AC-070, AC-072, AC-073)', () => {
  test('should request only DOM media URLs without a body and store only the AC-035 fields, settings, whitelist and counters while 3 feeds scroll (TC-093, TC-096)', async ({
    server,
  }) => {
    test.setTimeout(300_000);
    const profile = mkdtempSync(join(tmpdir(), 'purefeed-e2e-privacy-'));
    const context = await launchExtension(profile, catchAllHostRule(server.port));
    const domMedia = new Set<string>();
    const anchors = new Set<string>();
    const titles: string[] = [];
    const authors = new Set<string>();
    const served: string[] = [];
    let stored: StoredValue[] = [];
    let local: Record<string, unknown> = {};
    try {
      const id = await extensionIdOf(context);
      const ext = await context.newPage();
      await ext.goto(`chrome-extension://${id}/options.html`);
      for (const platform of ['wykop', 'reddit', 'x'] as Platform[]) {
        const posts = feedPosts({ platform, posts: 40, duplicates: 8 });
        for (const p of posts) authors.add(p.author);
        const title = `PureFeed privacy fixture ${platform} feed`;
        titles.push(title);
        const html = feedPage(platform, posts, { title, initial: 20 });
        served.push(html);
        const url = FEED_URL[platform]('privacy');
        await serveHtml(url, html);
        const page = await context.newPage();
        await page.goto(url);
        await page.waitForTimeout(1_500);
        await scrollFeed(page, 500);
        await page.waitForTimeout(2_000);
        const seen = await page.evaluate(() => {
          const media: string[] = [];
          for (const el of document.querySelectorAll('img, video, source')) {
            const m = el as HTMLImageElement & HTMLVideoElement;
            for (const v of [m.currentSrc, m.src, m.poster]) if (v) media.push(v);
            for (const candidate of (el.getAttribute('srcset') ?? '').split(',')) {
              const u = candidate.trim().split(/\s+/)[0];
              if (u) media.push(new URL(u, location.href).href);
            }
          }
          return { media, anchors: [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href) };
        });
        for (const u of seen.media) domMedia.add(u);
        for (const u of seen.anchors) anchors.add(u);
        await page.close();
      }
      await ext.waitForTimeout(2_500);
      expect((await sendFromPage(ext, { type: 'status/get' })).counters.uniqueItems).toBeGreaterThan(0);
      stored = await ext.evaluate(async () => {
        type D = string | number | boolean | null | { typedArray: string; bytes: number } | D[] | { [key: string]: D };
        const summarize = (v: unknown): D => {
          if (ArrayBuffer.isView(v)) return { typedArray: v.constructor.name, bytes: v.byteLength };
          if (v instanceof ArrayBuffer) return { typedArray: 'ArrayBuffer', bytes: v.byteLength };
          if (Array.isArray(v)) return v.map(summarize);
          if (v instanceof Blob) return { typedArray: 'Blob', bytes: v.size };
          if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, summarize(x)]));
          return v as D;
        };
        const request = <T>(r: IDBRequest<T>) =>
          new Promise<T>((resolve, reject) => {
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
        const out: Array<{ db: string; store: string; value: D }> = [];
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          const db = await request(indexedDB.open(info.name));
          for (const store of [...db.objectStoreNames]) {
            const values = await request(db.transaction(store).objectStore(store).getAll());
            for (const value of values) out.push({ db: info.name, store, value: summarize(value) });
          }
          db.close();
        }
        return out;
      });
      local = await ext.evaluate(() =>
        (
          globalThis as unknown as { chrome: { storage: { local: { get(k: null): Promise<Record<string, unknown>> } } } }
        ).chrome.storage.local.get(null),
      );
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }

    const fromExtension = server.log.filter((e) => e.fromExtension && !isBrowserServiceRequest(e));
    expect(fromExtension.length).toBeGreaterThan(0);
    expect(fromExtension.filter((e) => e.hasBody)).toEqual([]);
    expect(fromExtension.filter((e) => !MEDIA_HOSTS.includes(e.host as (typeof MEDIA_HOSTS)[number])).map((e) => e.host)).toEqual([]);
    expect(fromExtension.map((e) => `https://${e.host}${e.path}`).filter((u) => !domMedia.has(u))).toEqual([]);
    const allowed = new Set<string>([...PLATFORM_HOSTS, ...MEDIA_HOSTS]);
    const pageHosts = new Set(served.flatMap((html) => [...html.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1])));
    expect(
      [...new Set(server.log.filter((e) => !isBrowserServiceRequest(e)).map((e) => e.host))].filter(
        (h) => !allowed.has(h) && !pageHosts.has(h),
      ),
    ).toEqual([]);

    expect(stored.length).toBeGreaterThan(0);
    for (const { store, value } of stored) {
      expect(typeof value === 'object' && value !== null && !Array.isArray(value), store).toBe(true);
      const record = value as { [key: string]: Described };
      expect(Object.keys(record).sort(), store).toEqual(RECORD_FIELDS);
      const fp = record.fingerprint as { [key: string]: Described };
      expect(Object.keys(fp).filter((k) => !FINGERPRINT_FIELDS.has(k))).toEqual([]);
      expect(Object.values(fp).reduce((sum: number, v) => sum + (isTyped(v) ? v.bytes : 0), 0)).toBeLessThanOrEqual(MAX_FINGERPRINT_BYTES);
      expect(['image', 'gif', 'video']).toContain(record.contentType);
      expect(['reddit', 'wykop', 'x']).toContain(record.platform);
      expect(anchors.has(String(record.firstSeenPermalink)), String(record.firstSeenPermalink)).toBe(true);
      const others = strings(record, new Set(['firstSeenPermalink']));
      expect(
        others.filter((s) => /https?:|\/\//.test(s) || titles.some((t) => s.includes(t)) || [...authors].some((a) => s.includes(a))),
      ).toEqual([]);
    }
    const localText = JSON.stringify(local);
    expect(localText).not.toMatch(/https?:/);
    expect(titles.filter((t) => localText.includes(t))).toEqual([]);
    expect([...authors].filter((a) => localText.includes(a))).toEqual([]);
  });
});
