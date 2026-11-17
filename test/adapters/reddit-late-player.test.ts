// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintSequence } from '../../src/fingerprint/frame-sequence.ts';
import type { Request } from '../../src/shared/messages.ts';
import { decodeGrayFrame, encodeDecodeResult } from '../../src/shared/wire.ts';
import { createFakeBackground } from '../helpers/fake-background.ts';
import { createFakeClock, type FakeClock, settle } from '../helpers/fake-ext.ts';
import { type FakeMedia, installFakeMedia, videoFromAsset } from '../helpers/fake-media.ts';
import { createFakeObservers, type FakeObservers, setLayout } from '../helpers/fake-observers.ts';
import { fragment, setUrl } from '../helpers/fixtures.ts';

const NOW = Date.UTC(2026, 10, 17, 12);
const CLIP_BLOB_1 = 'blob:https://www.reddit.com/7e1a0c00-0000-4000-8000-000000000001';
const CLIP_BLOB_2 = 'blob:https://www.reddit.com/7e1a0c00-0000-4000-8000-000000000002';

let media: FakeMedia;
let running: Array<{ stop(): void }> = [];

beforeEach(() => {
  media = installFakeMedia();
  media.addVideo(CLIP_BLOB_1, videoFromAsset('clip.mp4'));
  media.addVideo(CLIP_BLOB_2, videoFromAsset('clip.mp4'));
  setUrl('https://www.reddit.com/');
});

afterEach(() => {
  for (const runtime of running) runtime.stop();
  running = [];
  media.restore();
  document.body.replaceChildren();
});

function redditVideoPost(id: string): string {
  const permalink = `/r/pf_videos/comments/${id}/synthetic_video_${id}/`;
  return `
<article class="w-full m-0" aria-label="Synthetic video post ${id}">
  <shreddit-post id="t3_${id}" permalink="${permalink}" view-context="AggregateFeed" post-type="video" domain="v.redd.it"
    author="pf_${id}" author-id="t2_${id}" subreddit-prefixed-name="r/pf_videos" subreddit-name="pf_videos" post-title="Synthetic video ${id}">
    <a slot="full-post-link" class="absolute inset-0" href="https://www.reddit.com${permalink}" target="_self">Synthetic video ${id}</a>
    <a slot="title" href="${permalink}">Synthetic video ${id}</a>
    <div slot="post-media-container" class="block w-full">
      <div class="relative overflow-hidden pointer-cursor">
        <div id="t3_${id}-aspect-ratio" class="relative block w-full">
          <div class="absolute inset-0 h-full">
            <activate-feature>
              <shreddit-async-loader>
                <shreddit-player class="block h-full w-full" src="https://v.redd.it/${id}/HLSPlaylist.m3u8?f=hd&amp;v=1" autoplay=""
                  player-type="in_feed_player" post-id="t3_${id}" post-type="video" style="width: 545px; height: 540px">
                  <source src="https://v.redd.it/${id}/HLSPlaylist.m3u8?f=hd&amp;v=1" type="application/vnd.apple.mpegURL" />
                </shreddit-player>
              </shreddit-async-loader>
            </activate-feature>
          </div>
        </div>
      </div>
    </div>
  </shreddit-post>
</article>`;
}

function attachPlayerVideo(post: Element, src: string, top: number): HTMLVideoElement {
  const player = post.querySelector('shreddit-player') as Element;
  const shadow = player.attachShadow({ mode: 'open' });
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-label', 'video player');
  video.setAttribute('src', src);
  setLayout(video, { top, width: 545, height: 540 });
  shadow.append(video);
  return video;
}

async function playVideos(clock: FakeClock, videos: HTMLVideoElement[], toS: number, stepS = 0.25) {
  const setPlayhead = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set;
  for (let t = 0; t <= toS + 1e-9; t += stepS) {
    for (const v of videos) setPlayhead?.call(v, Math.round(t * 1000) / 1000);
    await clock.advance(stepS * 1000);
    await settle(2);
  }
  await settle();
}

async function openRedditSession(clock: FakeClock, observers: FakeObservers) {
  const bg = createFakeBackground({ media: {}, now: clock.now });
  const send = (async (req: Request) => {
    if (req.type !== 'media/frames') return bg.send(req);
    bg.requests.push(JSON.parse(JSON.stringify(req)));
    if (req.frames.length === 0) return encodeDecodeResult({ status: 'skipped', reason: 'no-poster' });
    const frames = req.frames.map((f) => decodeGrayFrame(f));
    return encodeDecodeResult({ status: 'ok', contentType: 'video', fingerprint: fingerprintSequence(frames, req.durationS) });
  }) as typeof bg.send;
  const { redditAdapter } = await import('../../src/adapters/reddit.ts');
  const { createContentRuntime } = await import('../../src/content/runtime.ts');
  document.body.append(fragment(document, '<shreddit-feed></shreddit-feed>'));
  const runtime = createContentRuntime({
    adapter: redditAdapter,
    doc: document,
    win: window,
    send,
    createObserver: observers.factory,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  running.push(runtime);
  runtime.start();
  await settle();
  return { bg, feed: document.querySelector('shreddit-feed') as Element };
}

describe('Reddit player whose shadow root attaches after the post was scanned (AC-042, AC-045, AC-015)', () => {
  it('should sample and hide a later Reddit video post if its player shadow root and video attach after the post was scanned', async () => {
    const clock = createFakeClock(NOW);
    const observers = createFakeObservers();
    const { bg, feed } = await openRedditSession(clock, observers);
    const early = fragment(document, redditVideoPost('1pflate1'));
    const late = fragment(document, redditVideoPost('1pflate2'));
    setLayout(early, { top: 0, width: 640, height: 600 });
    setLayout(late, { top: 600, width: 640, height: 600 });
    const earlyVideo = attachPlayerVideo(early, CLIP_BLOB_1, 40);
    feed.append(early, late);
    await settle();
    const earlyPost = early.querySelector('shreddit-post') as Element;
    const latePost = late.querySelector('shreddit-post') as Element;
    observers.enterLookahead(earlyPost, latePost, earlyVideo);
    await settle();
    await clock.advance(2000);

    const lateVideo = attachPlayerVideo(late, CLIP_BLOB_2, 640);
    await settle();
    observers.enterLookahead(lateVideo);
    observers.setVisible(latePost, 1);
    observers.setVisible(lateVideo, 1);
    await settle();
    await playVideos(clock, [earlyVideo, lateVideo], 20);

    const frames = bg.requests.filter((r): r is Extract<Request, { type: 'media/frames' }> => r.type === 'media/frames');
    expect(frames.map((r) => r.frames.length)).toEqual([8, 8]);
    expect(frames.every((r) => r.durationS === 20)).toBe(true);
    expect(bg.fingerprintUrls()).toEqual([]);
    expect(latePost.hasAttribute('data-purefeed-hidden')).toBe(true);
    expect(earlyPost.hasAttribute('data-purefeed-hidden')).toBe(false);
  });

  it('should sample a shreddit-player video if its shadow root attaches 10 s after the post entered the viewport', async () => {
    const clock = createFakeClock(NOW);
    const observers = createFakeObservers();
    const { bg, feed } = await openRedditSession(clock, observers);
    const root = fragment(document, redditVideoPost('1pflate3'));
    setLayout(root, { top: 0, width: 640, height: 600 });
    feed.append(root);
    await settle();
    const post = root.querySelector('shreddit-post') as Element;
    observers.enterLookahead(post);
    observers.setVisible(post, 1);
    await clock.advance(10_000);
    expect(bg.requests.filter((r) => r.type === 'media/frames')).toEqual([]);

    const video = attachPlayerVideo(root, CLIP_BLOB_1, 40);
    await settle();
    observers.enterLookahead(video);
    observers.setVisible(video, 1);
    await playVideos(clock, [video], 20);

    const frames = bg.requests.filter((r): r is Extract<Request, { type: 'media/frames' }> => r.type === 'media/frames');
    expect(frames.map((r) => r.frames.length)).toEqual([8]);
  });
});
