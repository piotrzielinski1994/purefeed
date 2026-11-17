import type { PlatformAdapter } from './adapter.ts';
import { redditAdapter } from './reddit.ts';
import { wykopAdapter } from './wykop.ts';
import { xAdapter } from './x.ts';

const ADAPTERS: ReadonlyMap<string, PlatformAdapter> = new Map([
  ['www.reddit.com', redditAdapter],
  ['wykop.pl', wykopAdapter],
  ['x.com', xAdapter],
]);

export const adapterForHost = (host: string): PlatformAdapter | null => ADAPTERS.get(host) ?? null;
