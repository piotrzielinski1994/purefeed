// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

const loadNavigation = () => import('./navigation.ts');

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

beforeEach(() => {
  setUrl('https://www.reddit.com/');
});

describe('watchUrl (AC-047)', () => {
  it('should report an in-app navigation by history.pushState once (TC-066)', async () => {
    const { watchUrl } = await loadNavigation();
    const changes: string[] = [];
    const stop = watchUrl(window, (href) => changes.push(href), 10);
    history.pushState({}, '', '/r/memes/');
    await wait(80);
    stop();
    expect(changes).toEqual(['https://www.reddit.com/r/memes/']);
  });

  it('should report a back navigation that fires popstate', async () => {
    const { watchUrl } = await loadNavigation();
    const changes: string[] = [];
    const stop = watchUrl(window, (href) => changes.push(href), 10_000);
    history.pushState({}, '', '/r/pics/');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await wait(20);
    stop();
    expect(changes).toEqual(['https://www.reddit.com/r/pics/']);
  });

  it('should report nothing if the URL does not change', async () => {
    const { watchUrl } = await loadNavigation();
    const changes: string[] = [];
    const stop = watchUrl(window, (href) => changes.push(href), 10);
    await wait(60);
    stop();
    expect(changes).toEqual([]);
  });

  it('should report each of 2 navigations', async () => {
    const { watchUrl } = await loadNavigation();
    const changes: string[] = [];
    const stop = watchUrl(window, (href) => changes.push(href), 10);
    history.pushState({}, '', '/r/a/');
    await wait(60);
    history.pushState({}, '', '/r/b/');
    await wait(60);
    stop();
    expect(changes).toEqual(['https://www.reddit.com/r/a/', 'https://www.reddit.com/r/b/']);
  });

  it('should report nothing after stop', async () => {
    const { watchUrl } = await loadNavigation();
    const changes: string[] = [];
    const stop = watchUrl(window, (href) => changes.push(href), 10);
    stop();
    history.pushState({}, '', '/r/later/');
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await wait(60);
    expect(changes).toEqual([]);
  });
});
