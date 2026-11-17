// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, settle } from '../../test/helpers/fake-ext.ts';
import { createFakeObservers, setLayout } from '../../test/helpers/fake-observers.ts';

const loadTracker = () => import('./seen-tracker.ts');

afterEach(() => {
  document.body.replaceChildren();
});

async function setup() {
  const { createSeenTracker } = await loadTracker();
  const clock = createFakeClock();
  const observers = createFakeObservers();
  const seen: Element[] = [];
  const tracker = createSeenTracker({
    createObserver: observers.factory,
    dwellMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onSeen: (el) => seen.push(el),
  });
  const img = document.createElement('img');
  img.src = 'https://i.redd.it/a.png';
  setLayout(img, { top: 100, width: 600, height: 400 });
  document.body.append(img);
  return { tracker, clock, observers, seen, img };
}

describe('createSeenTracker (AC-032)', () => {
  it('should report an item seen if >= 50% of it is visible for 1 continuous second (TC-045)', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.6);
    await clock.advance(1000);
    expect(seen).toEqual([img]);
  });

  it('should not report an item visible for 0.9 s and then scrolled away (TC-045)', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.6);
    await clock.advance(900);
    observers.setVisible(img, 0);
    await clock.advance(5000);
    expect(seen).toEqual([]);
  });

  it('should restart the dwell time if the item leaves and enters the viewport again', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.6);
    await clock.advance(900);
    observers.setVisible(img, 0.2);
    await clock.advance(100);
    observers.setVisible(img, 0.6);
    await clock.advance(900);
    expect(seen).toEqual([]);
    await clock.advance(100);
    expect(seen).toEqual([img]);
  });

  it('should not report an item that is 40% visible for 5 s (TC-045)', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.4);
    await clock.advance(5000);
    expect(seen).toEqual([]);
  });

  it('should report an item that is exactly 50% visible for 1 s', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.5);
    await clock.advance(1000);
    expect(seen).toEqual([img]);
  });

  it('should report an item once if it stays visible', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 1);
    await clock.advance(10_000);
    expect(seen).toEqual([img]);
  });

  it('should not report an item that is untracked during the dwell time', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    tracker.track(img);
    await settle();
    observers.setVisible(img, 0.6);
    await clock.advance(500);
    tracker.untrack(img);
    await clock.advance(5000);
    expect(seen).toEqual([]);
  });

  it('should time 2 items independently', async () => {
    const { tracker, clock, observers, seen, img } = await setup();
    const other = document.createElement('img');
    setLayout(other, { top: 500, width: 600, height: 400 });
    document.body.append(other);
    tracker.track(img);
    tracker.track(other);
    await settle();
    observers.setVisible(img, 0.8);
    await clock.advance(600);
    observers.setVisible(other, 0.8);
    await clock.advance(400);
    expect(seen).toEqual([img]);
    await clock.advance(600);
    expect(seen).toEqual([img, other]);
  });
});
