import type { PlatformAdapter } from './adapter.ts';

const ADAPTERS: ReadonlyMap<string, PlatformAdapter> = new Map();

export const adapterForHost = (host: string): PlatformAdapter | null => ADAPTERS.get(host) ?? null;
