import type { PlatformAdapter } from './adapter.ts';
import { redditAdapter } from './reddit.ts';
import { wykopAdapter } from './wykop.ts';

const ADAPTERS: ReadonlyMap<string, PlatformAdapter> = new Map([
  ['www.reddit.com', redditAdapter],
  ['wykop.pl', wykopAdapter],
]);

export const adapterForHost = (host: string): PlatformAdapter | null => ADAPTERS.get(host) ?? null;
