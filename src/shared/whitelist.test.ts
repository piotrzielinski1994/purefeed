import { describe, expect, it } from 'vitest';
import type { Platform } from './types.ts';

const loadWhitelist = () => import('./whitelist.ts');

describe('whitelist source input (AC-056)', () => {
  it('should turn r/<name> and u/<name> into Reddit source keys (TC-075)', async () => {
    const { parseSourceInput } = await loadWhitelist();
    expect(parseSourceInput('reddit', 'r/memes')).toEqual({ ok: true, entry: { type: 'source', key: 'reddit:r/memes' } });
    expect(parseSourceInput('reddit', 'u/Some_User-1')).toEqual({ ok: true, entry: { type: 'source', key: 'reddit:u/Some_User-1' } });
  });

  it('should turn @<name> into Wykop and X source keys', async () => {
    const { parseSourceInput } = await loadWhitelist();
    expect(parseSourceInput('wykop', '@pf_author')).toEqual({ ok: true, entry: { type: 'source', key: 'wykop:@pf_author' } });
    expect(parseSourceInput('x', '@somehandle')).toEqual({ ok: true, entry: { type: 'source', key: 'x:@somehandle' } });
  });

  it('should reject a name without a platform prefix with an inline message on every platform (TC-076)', async () => {
    const { parseSourceInput } = await loadWhitelist();
    for (const platform of ['reddit', 'wykop', 'x'] satisfies Platform[]) {
      const result = parseSourceInput(platform, 'memes');
      expect(result.ok, platform).toBe(false);
      expect(result.ok ? '' : result.message.trim(), platform).not.toBe('');
    }
  });

  it('should reject a prefix that belongs to another platform', async () => {
    const { parseSourceInput } = await loadWhitelist();
    const cases: Array<[Platform, string]> = [
      ['reddit', '@memes'],
      ['wykop', 'r/memes'],
      ['wykop', 'u/memes'],
      ['x', 'r/memes'],
      ['x', 'u/memes'],
    ];
    for (const [platform, text] of cases) {
      expect(parseSourceInput(platform, text).ok, `${platform} ${text}`).toBe(false);
    }
  });

  it('should accept a 50-character name and reject an empty name, a 51-character name or other characters', async () => {
    const { parseSourceInput } = await loadWhitelist();
    expect(parseSourceInput('reddit', `r/${'a'.repeat(50)}`)).toEqual({
      ok: true,
      entry: { type: 'source', key: `reddit:r/${'a'.repeat(50)}` },
    });
    for (const text of ['r/', `r/${'a'.repeat(51)}`, 'r/me mes', 'r/memes/top', '']) {
      expect(parseSourceInput('reddit', text).ok, text).toBe(false);
    }
    for (const text of ['@', '@na.me', '@żółw', '@@name']) {
      expect(parseSourceInput('x', text).ok, text).toBe(false);
    }
  });
});
