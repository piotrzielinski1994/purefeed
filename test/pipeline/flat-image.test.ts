// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, settle } from '../helpers/fake-ext.ts';
import { createFakeObservers } from '../helpers/fake-observers.ts';
import { createRealBackground } from '../helpers/real-background.ts';
import { createTestAdapter, makeFeed, mediaOf, type PostSpec } from '../helpers/test-adapter.ts';

const GRAY = 'https://i.redd.it/solid-gray.png';
const GRAY_2 = 'https://i.redd.it/solid-gray-2.png';
const ROUTES = { [GRAY]: { asset: 'solid-gray.png', mime: 'image/png' }, [GRAY_2]: { asset: 'solid-gray-2.png', mime: 'image/png' } };

let running: Array<{ stop(): void }> = [];

afterEach(() => {
  running.forEach((runtime) => {
    runtime.stop();
  });
  running = [];
  document.body.replaceChildren();
});

describe('solid gray images through runtime, background, decoder and hash worker (AC-009, TC-011)', () => {
  it('should never record a seen solid gray 600 x 600 image and keep a new post with another solid gray image visible (TC-011)', async () => {
    const clock = createFakeClock();
    const bg = await createRealBackground({ routes: ROUTES, clock });
    const { createContentRuntime } = await import('../../src/content/runtime.ts');
    const session = async (specs: PostSpec[]) => {
      document.body.replaceChildren();
      const observers = createFakeObservers();
      const { posts } = makeFeed(document, specs);
      const runtime = createContentRuntime({
        adapter: createTestAdapter('reddit'),
        doc: document,
        win: window,
        send: bg.send,
        createObserver: observers.factory,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
      running.push(runtime);
      runtime.start();
      await settle();
      observers.enterLookahead(...posts);
      await settle();
      posts.forEach((post) => {
        observers.setVisible(mediaOf(post), 1);
      });
      await clock.advance(1000);
      runtime.stop();
      return posts;
    };
    await session([{ id: 'g1', media: [{ kind: 'img', src: GRAY, width: 600, height: 600 }] }]);
    const later = await session([
      { id: 'g2', top: 0, media: [{ kind: 'img', src: GRAY_2, width: 600, height: 600 }] },
      { id: 'g3', top: 700, media: [{ kind: 'img', src: GRAY, width: 600, height: 600 }] },
    ]);
    expect(bg.responsesOf('media/fingerprint')).toEqual([
      { status: 'skipped', reason: 'flat' },
      { status: 'skipped', reason: 'flat' },
      { status: 'skipped', reason: 'flat' },
    ]);
    expect(bg.workerJobs).toEqual(['image', 'image']);
    expect(later.map((post) => post.hasAttribute('data-purefeed-hidden'))).toEqual([false, false]);
    expect(bg.exchanges.filter((e) => e.req.type === 'seen/lookup' || e.req.type === 'seen/record')).toEqual([]);
  });
});
