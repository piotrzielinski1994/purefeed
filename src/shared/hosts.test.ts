import { describe, expect, it } from 'vitest';
import { MEDIA_HOSTS } from './hosts.ts';

const loadHosts = () => import('./hosts.ts');

describe('isMediaUrlAllowed (AC-070)', () => {
  it('should allow an https URL if its host is one of the media CDN hosts', async () => {
    const { isMediaUrlAllowed } = await loadHosts();
    const urls = MEDIA_HOSTS.map((host) => `https://${host}/media/abc.jpg?width=640&format=pjpg&auto=webp&s=0123`);
    expect(urls.map((url) => isMediaUrlAllowed(url))).toEqual(MEDIA_HOSTS.map(() => true));
  });

  it('should reject a media host URL if its scheme is not https', async () => {
    const { isMediaUrlAllowed } = await loadHosts();
    expect(isMediaUrlAllowed('http://i.redd.it/abc.jpg')).toBe(false);
    expect(isMediaUrlAllowed('ftp://pbs.twimg.com/media/abc.jpg')).toBe(false);
  });

  it('should reject a URL if its host is a platform page host but not a media host', async () => {
    const { isMediaUrlAllowed } = await loadHosts();
    expect(isMediaUrlAllowed('https://x.com/someone/status/1/photo/1')).toBe(false);
    expect(isMediaUrlAllowed('https://www.reddit.com/media?url=https%3A%2F%2Fi.redd.it%2Fabc.jpg')).toBe(false);
  });

  it('should reject a URL if a media host name only appears in a lookalike host, the path or the user info', async () => {
    const { isMediaUrlAllowed } = await loadHosts();
    expect(isMediaUrlAllowed('https://i.redd.it.evil.example/abc.jpg')).toBe(false);
    expect(isMediaUrlAllowed('https://evilpbs.twimg.com/media/abc.jpg')).toBe(false);
    expect(isMediaUrlAllowed('https://evil.example/i.redd.it/abc.jpg')).toBe(false);
    expect(isMediaUrlAllowed('https://i.redd.it@evil.example/abc.jpg')).toBe(false);
    expect(isMediaUrlAllowed('https://media2.test/base.png')).toBe(false);
  });

  it('should reject blob, data and malformed URLs', async () => {
    const { isMediaUrlAllowed } = await loadHosts();
    expect(isMediaUrlAllowed('blob:https://x.com/6c1f4a1e-0d1b-4a3e-9b52-1f0f3c1d2e3f')).toBe(false);
    expect(isMediaUrlAllowed('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isMediaUrlAllowed('not a url')).toBe(false);
    expect(isMediaUrlAllowed('')).toBe(false);
  });
});
