// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { adapterForHost } from './registry.ts';

describe('adapter registry (AC-049)', () => {
  it('should return the adapter of each supported platform host', () => {
    expect(adapterForHost('www.reddit.com')?.platform).toBe('reddit');
    expect(adapterForHost('wykop.pl')?.platform).toBe('wykop');
    expect(adapterForHost('x.com')?.platform).toBe('x');
  });

  it('should return no adapter for out-of-scope layouts and other sites while supported hosts have one', () => {
    expect(adapterForHost('www.reddit.com')).not.toBeNull();
    for (const host of ['old.reddit.com', 'new.reddit.com', 'twitter.com', 'example.com', 'i.redd.it', 'pbs.twimg.com']) {
      expect(adapterForHost(host), host).toBeNull();
    }
  });
});
