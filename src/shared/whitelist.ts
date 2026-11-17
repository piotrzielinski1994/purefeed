import type { Platform, WhitelistEntry } from './types.ts';

const NAME = '[A-Za-z0-9_-]{1,50}';
const NAME_RULE = '1-50 letters, digits, _ or -';

const HANDLE = { pattern: new RegExp(`^@${NAME}$`), message: `Enter @name (${NAME_RULE}).` };

const SOURCE_INPUT: Record<Platform, typeof HANDLE> = {
  reddit: { pattern: new RegExp(`^[ru]/${NAME}$`), message: `Enter r/name or u/name (${NAME_RULE}).` },
  wykop: HANDLE,
  x: HANDLE,
};

export type SourceInputResult = { ok: true; entry: WhitelistEntry } | { ok: false; message: string };

export function parseSourceInput(platform: Platform, text: string): SourceInputResult {
  const { pattern, message } = SOURCE_INPUT[platform];
  const source = text.trim();
  return pattern.test(source) ? { ok: true, entry: { type: 'source', key: `${platform}:${source}` } } : { ok: false, message };
}

const isEntry = (value: unknown): value is WhitelistEntry =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  (value.type === 'post' || value.type === 'source') &&
  'key' in value &&
  typeof value.key === 'string';

export const whitelistEntries = (stored: unknown): WhitelistEntry[] => (Array.isArray(stored) ? stored.filter(isEntry) : []);
