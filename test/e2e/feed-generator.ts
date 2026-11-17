import type { Page } from '@playwright/test';
import type { Platform } from '../../src/shared/types.ts';
import { redditImagePost, wykopImageEntry, xPhotoTweet } from '../helpers/platform-markup.ts';
import { type RequestLogEntry, servePage } from './server.ts';

export type FeedMedia = { kind: 'img'; src: string } | { kind: 'video'; src: string; poster?: string; muted?: boolean };
export type FeedPost = { id: string; author: string; media: FeedMedia | null; marks?: Record<string, string> };
export type FeedPageOpts = { title?: string; css?: string; headScript?: string; script?: string; initial?: number };

export const FEED_URL: Record<Platform, (name: string) => string> = {
  reddit: (name) => `https://www.reddit.com/?pf=${name}`,
  wykop: (name) => `https://wykop.pl/mikroblog/?pf=${name}`,
  x: (name) => `https://x.com/home?pf=${name}`,
};

const MEDIA_URL: Record<Platform, (asset: string, tag: string) => string> = {
  reddit: (asset, tag) => `https://i.redd.it/${asset}?pf=${tag}`,
  wykop: (asset, tag) => `https://wykop.pl/cdn/c3201142/${asset}?pf=${tag}`,
  x: (asset, tag) => `https://pbs.twimg.com/media/${asset}?format=${asset.split('.').pop()}&name=small&pf=${tag}`,
};

export const mediaUrl = (platform: Platform, asset: string, tag: string): string => MEDIA_URL[platform](asset, tag);

const BASE_CSS = `
  body { margin: 0; font-family: sans-serif; }
  shreddit-app, shreddit-feed, shreddit-post, article, section { display: block; position: relative; }
  .hidden { display: none; }
  .absolute { position: absolute; }
  .relative { position: relative; }
  .overflow-hidden { overflow: hidden; }
  .inset-0 { inset: 0; }
  .pf-text { min-height: 120px; padding: 12px; border-bottom: 1px solid #ccc; }
  [data-aspect-ratio-container] { height: 540px; }
`;

const escapeAttr = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

function withMarks(html: string, openTag: string, marks: Record<string, string> | undefined): string {
  if (!marks) return html;
  const attrs = Object.entries(marks)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  const at = html.indexOf(openTag);
  if (at < 0) throw new Error(`post markup has no ${openTag}`);
  return `${html.slice(0, at + openTag.length)}${attrs}${html.slice(at + openTag.length)}`;
}

function redditPost(p: FeedPost): string {
  if (p.media?.kind === 'video') throw new Error('generated Reddit feeds hold no video posts');
  if (p.media) return withMarks(redditImagePost({ id: p.id, author: p.author, src: p.media.src }), '<shreddit-post', p.marks);
  const permalink = `/r/pf_text/comments/${p.id}/synthetic_text_${p.id}/`;
  return withMarks(
    `
<article class="w-full m-0" aria-label="Synthetic text post ${p.id}">
  <shreddit-post id="t3_${p.id}" permalink="${permalink}" view-context="AggregateFeed" post-type="text" domain="self.pf_text"
    author="${p.author}" author-id="t2_${p.author}" subreddit-prefixed-name="r/pf_text" subreddit-name="pf_text" post-title="Synthetic text ${p.id}">
    <a slot="full-post-link" class="absolute inset-0" href="https://www.reddit.com${permalink}" target="_self">Synthetic text ${p.id}</a>
    <a slot="title" href="${permalink}">Synthetic text ${p.id}</a>
    <div slot="text-body" class="pf-text"><p>Synthetic text body of post ${p.id}.</p></div>
  </shreddit-post>
</article>`,
    '<shreddit-post',
    p.marks,
  );
}

function wykopEntry(p: FeedPost): string {
  if (p.media?.kind === 'img')
    return withMarks(wykopImageEntry({ id: p.id, author: p.author, src: p.media.src }), '<section data-level="1"', p.marks);
  const media =
    p.media?.kind === 'video'
      ? `
    <div class="media">
      <section class="multimedia">
        <div class="video">
          <video id="pf-video-${p.id}" src="${escapeAttr(p.media.src)}"${p.media.poster ? ` poster="${escapeAttr(p.media.poster)}"` : ''} autoplay${p.media.muted === false ? '' : ' muted'} playsinline preload="auto" style="width: 320px; height: 180px"></video>
        </div>
      </section>
    </div>`
      : '';
  return withMarks(
    `
<section data-level="1" id="thread-${p.id}" class="thread visible">
  <section class="item">
    <header>
      <a href="/ludzie/${p.author}" class="avatar active" style="width: 27px; height: 27px;"><span>${p.author}</span></a>
      <div>
        <a href="/ludzie/${p.author}" class="username active"><span>${p.author}</span></a>
        <a href="/wpis/${p.id}/synthetic-entry-${p.id}" target="_blank" class="date"><time datetime="2026-11-17 10:00:00" class="date">1 godz.</time></a>
      </div>
    </header>
    <div data-thread-item-selectable="${p.id}" class="content">
      <div><section class="entry-content"><div class="wrapper${p.media ? '' : ' pf-text'}">Synthetic entry ${p.id}</div></section></div>
    </div>${media}
    <footer><button class="comments">0</button></footer>
  </section>
</section>`,
    '<section data-level="1"',
    p.marks,
  );
}

function xTweet(p: FeedPost): string {
  if (p.media?.kind === 'video') throw new Error('generated X feeds hold no video posts');
  if (p.media) {
    const html = xPhotoTweet({ id: p.id, author: p.author, src: p.media.src }).replace(
      'style="transform: translateY(0px); position: absolute; width: 100%;"',
      'style="position: relative; width: 100%;"',
    );
    return withMarks(html, '<article', p.marks);
  }
  return withMarks(
    `
<div data-testid="cellInnerDiv" style="position: relative; width: 100%;">
  <article aria-labelledby="id__${p.id}" role="article" tabindex="0" data-testid="tweet">
    <div data-testid="User-Name">
      <a href="/${p.author}" role="link"><span>Synthetic ${p.author}</span></a>
      <a href="/${p.author}" role="link" tabindex="-1"><span>@${p.author}</span></a>
      <a href="/${p.author}/status/${p.id}" dir="ltr" aria-label="Nov 17" role="link"><time datetime="2026-11-17T10:00:00.000Z">Nov 17</time></a>
    </div>
    <div data-testid="tweetText" lang="en" class="pf-text"><span>Synthetic tweet ${p.id}</span></div>
  </article>
</div>`,
    '<article',
    p.marks,
  );
}

const POST: Record<Platform, (p: FeedPost) => string> = { reddit: redditPost, wykop: wykopEntry, x: xTweet };

const FEED_SHELL: Record<Platform, (posts: string, rest: string) => string> = {
  reddit: (posts, rest) =>
    `<shreddit-app><main id="main-content"><shreddit-feed data-pf-feed="">${posts}</shreddit-feed></main></shreddit-app>${rest}`,
  wykop: (posts, rest) => `<main><section class="listing"><div class="content" data-pf-feed="">${posts}</div></section></main>${rest}`,
  x: (posts, rest) =>
    `<main role="main"><div aria-label="Timeline: Your Home Timeline"><div data-pf-feed="" style="position: relative">${posts}</div></div></main>${rest}`,
};

const INFINITE_SCROLL = `
(() => {
  const feed = document.querySelector('[data-pf-feed]');
  const template = document.getElementById('pf-rest');
  const rest = template ? [...template.content.children] : [];
  const state = (window.__pfFeed = { total: feed.children.length + rest.length, appended: feed.children.length });
  let next = 0;
  const more = () => {
    while (next < rest.length && scrollY + innerHeight * 3 >= document.documentElement.scrollHeight) {
      const batch = rest.slice(next, next + 20);
      next += batch.length;
      feed.append(...batch.map((node) => document.importNode(node, true)));
      state.appended += batch.length;
    }
  };
  addEventListener('scroll', more, { passive: true });
  more();
})();
`;

export function feedPage(platform: Platform, posts: FeedPost[], opts: FeedPageOpts = {}): string {
  const initial = opts.initial ?? posts.length;
  const markup = posts.map((p) => POST[platform](p));
  const rest = markup.length > initial ? `<template id="pf-rest">${markup.slice(initial).join('\n')}</template>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${opts.title ?? `Fixture: ${platform} feed`}</title>
    <style>${BASE_CSS}${opts.css ?? ''}</style>
    ${opts.headScript ? `<script>${opts.headScript}</script>` : ''}
  </head>
  <body>
    ${FEED_SHELL[platform](markup.slice(0, initial).join('\n'), rest)}
    <script>${INFINITE_SCROLL}</script>
    ${opts.script ? `<script>${opts.script}</script>` : ''}
  </body>
</html>`;
}

const ORIGINALS = [
  'base.png',
  'other-1.png',
  'other-2.png',
  'other-3.png',
  'caption-a.png',
  'caption-b.png',
  'screenshot-1.png',
  'screenshot-2.png',
];
const BASE_COPIES = ['base-50.png', 'base-q60.jpg', 'base.webp', 'base-200.png'];

const POST_ID: Record<Platform, (i: number) => string> = {
  reddit: (i) => `pfg${i.toString(36)}`,
  wykop: (i) => String(91_000_000 + i),
  x: (i) => `18700000000${String(i).padStart(8, '0')}`,
};

export function feedPosts(opts: { platform: Platform; posts: number; duplicates: number }): FeedPost[] {
  const { platform, posts, duplicates } = opts;
  const mediaCount = ORIGINALS.length + duplicates;
  if (posts < mediaCount) throw new Error(`a feed of ${posts} posts cannot hold ${mediaCount} media posts`);
  const step = posts / mediaCount;
  const mediaSlots = new Map<number, number>();
  for (let m = 0; m < mediaCount; m++) mediaSlots.set(Math.floor(m * step), m);
  const originalIndex: number[] = [];
  return Array.from({ length: posts }, (_, i): FeedPost => {
    const id = POST_ID[platform](i);
    const author = `pf_gen_${i % 17}`;
    const m = mediaSlots.get(i);
    if (m === undefined) return { id, author, media: null, marks: { 'data-pf-index': String(i) } };
    if (m < ORIGINALS.length) {
      originalIndex.push(i);
      return {
        id,
        author,
        media: { kind: 'img', src: mediaUrl(platform, ORIGINALS[m], `${i}`) },
        marks: { 'data-pf-index': String(i), 'data-pf-original': '' },
      };
    }
    const d = m - ORIGINALS.length;
    const k = d % ORIGINALS.length;
    const asset = k === 0 ? BASE_COPIES[Math.floor(d / ORIGINALS.length) % BASE_COPIES.length] : ORIGINALS[k];
    return {
      id,
      author,
      media: { kind: 'img', src: mediaUrl(platform, asset, `${i}`) },
      marks: { 'data-pf-index': String(i), 'data-pf-dup': String(originalIndex[k]) },
    };
  });
}

export function generateFeed(opts: { platform: Platform; posts: number; duplicates: number }): string {
  return feedPage(opts.platform, feedPosts(opts), { title: `Fixture: ${opts.platform} generated feed`, initial: 20 });
}

export async function serveHtml(url: string, html: string): Promise<void> {
  servePage(url, html);
}

export const HIDDEN = '[data-purefeed-hidden]';

export async function scrollFeed(page: Page, stepMs = 500, maxSteps = 2_000): Promise<number> {
  for (let step = 0; step < maxSteps; step++) {
    const done = await page.evaluate(() => {
      const feed = (window as unknown as { __pfFeed: { total: number; appended: number } }).__pfFeed;
      const atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
      if (feed.appended >= feed.total && atEnd) return true;
      scrollBy(0, innerHeight);
      return false;
    });
    if (done) return step;
    await page.waitForTimeout(stepMs);
  }
  throw new Error(`feed did not reach its end within ${maxSteps} scroll steps`);
}

const BROWSER_SERVICE_HOST = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com)$/;

export const isBrowserServiceRequest = (e: RequestLogEntry): boolean =>
  BROWSER_SERVICE_HOST.test(e.host) && !`${e.origin ?? ''} ${e.referer ?? ''}`.includes('chrome-extension://');
