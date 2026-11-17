import type { PlatformAdapter } from './adapter.ts';
import { redditAdapter } from './reddit.ts';

const ADAPTERS: ReadonlyMap<string, PlatformAdapter> = new Map([['www.reddit.com', redditAdapter]]);

export const adapterForHost = (host: string): PlatformAdapter | null => ADAPTERS.get(host) ?? null;
