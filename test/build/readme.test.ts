import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

type Section = { heading: string; body: string };

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    const match = fence ? null : /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { heading: match[2], body: '' };
      out.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return out;
}

function section(heading: RegExp): string {
  const all = sections(README);
  const index = all.findIndex((s) => heading.test(s.heading));
  if (index < 0) throw new Error(`README.md has no ## or ### heading matching ${heading}; headings: ${all.map((s) => s.heading).join(' | ')}`);
  const level =
    README.split('\n')
      .find((line) => line.replace(/^#+\s+/, '') === all[index].heading)
      ?.match(/^#+/)?.[0].length ?? 2;
  let body = all[index].body;
  for (const next of all.slice(index + 1)) {
    const nextLevel =
      README.split('\n')
        .find((line) => line.replace(/^#+\s+/, '') === next.heading)
        ?.match(/^#+/)?.[0].length ?? 2;
    if (nextLevel <= level) break;
    body += `${next.heading}\n${next.body}`;
  }
  return body;
}

const bullets = (body: string): string[] =>
  body
    .split('\n')
    .reduce<string[]>((items, line) => {
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(line) || /^\s*\|/.test(line)) items.push(line.trim());
      else if (line.trim() !== '' && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
      return items;
    }, [])
    .map((item) => item.replace(/\s+/g, ' '));

const LIMITS: Record<string, RegExp[]> = {
  'no OCR, small caption change can match (1.2)': [/\bOCR\b/, /caption|text/i, /1\s?%/],
  'DRM and cross-origin video fall back to the poster or skip (1.2)': [/\bDRM\b/, /poster/i],
  'Firefox temporary add-on removed on restart, signed XPI out of scope (1.2)': [/temporary/i, /restart/i, /\bXPI\b|signed/i],
  'platform DOM changes can break an adapter, generic fallback (1.2)': [/DOM/, /adapter|selector/i, /fallback/i],
  'no old.reddit.com (1.1)': [/old\.reddit\.com/],
  'no comments and replies (1.1)': [/comments?/i, /repl(y|ies)/i],
  'no link previews or link thumbnails (1.1)': [/link/i, /preview|thumbnail|card/i],
  'no text-only posts or text deduplication (1.1)': [/text/i, /text-only|text only|text deduplication/i],
  'no store publication (1.1)': [/Chrome Web Store|\bAMO\b|addons\.mozilla\.org/],
  'repost with an added logo or watermark counts as new content (Decision Log)': [/logo|watermark/i, /new content/i],
  'video poster-only until the page plays it, and for tainted videos (Decision Log)': [
    /poster/i,
    /play/i,
    /cross-origin|tainted|pixel access/i,
  ],
  'X selectors not confirmed on the live site (Decision Log)': [/\bX\b/, /selector/i, /not (yet )?confirmed|unconfirmed|login/i],
  'Reddit search feed not confirmed on the live site (Decision Log)': [/Reddit/, /search/i, /not (yet )?confirmed|unconfirmed/i],
  'daily purge alarm reset on background restart (Decision Log)': [/purge|retention/i, /alarm|24 ?h|daily/i, /restart/i],
  'video not played within 10 s keeps its poster-only result for the page session (Decision Log)': [/10 ?s/, /poster/i, /page session|reload/i],
  'third-party embeds not fingerprinted (Decision Log)': [/embed/i, /YouTube|third-party|iframe/i],
  'animated WebP and AVIF use the first frame only (Decision Log)': [/WebP/, /AVIF/, /first frame/i],
  'Firefox end-to-end tests manual only (Decision Log)': [/Firefox/, /manual/i, /E2E|end-to-end|automated|Playwright/i],
};

const CATEGORIES: Record<string, RegExp> = {
  'fingerprint algorithms': /fingerprint algorithm/i,
  'similarity thresholds': /similarity threshold/i,
  'cross-platform detection': /cross-platform/i,
  'resize and compression': /resiz\w*.*compress|compress\w*.*resiz/i,
  'video frame matching': /video frame/i,
  'dynamic DOM changes': /dynamic DOM/i,
  'false positives': /false positive/i,
  'IndexedDB persistence': /IndexedDB/i,
};

const TEST_FILE = /`([\w./-]+\.(?:test|spec)\.ts)`|\(([\w./-]+\.(?:test|spec)\.ts)\)/g;
const testFilesIn = (text: string): string[] => [...text.matchAll(TEST_FILE)].map((m) => m[1] ?? m[2]);

describe('README.md install, usage, privacy and limitations (AC-079, AC-003, TC-102)', () => {
  it('should hold a section for each AC-079 item if README.md is read', () => {
    for (const heading of [
      /prerequisite/i,
      /^build/i,
      /chrome/i,
      /firefox/i,
      /usage/i,
      /privacy/i,
      /limitation/i,
      /test map/i,
      /manual smoke/i,
    ]) {
      expect(() => section(heading), String(heading)).not.toThrow();
    }
  });

  it('should list Node 26, npm, ffmpeg 9 and mise install as prerequisites if the prerequisites section is read', () => {
    const body = section(/prerequisite/i);
    expect(body).toMatch(/Node(\.js)?\s*26/);
    expect(body).toMatch(/\bnpm\b/);
    expect(body).toMatch(/ffmpeg`?\s*9/);
    expect(body).toContain('mise install');
  });

  it('should give the build command and both build outputs if the build section is read', () => {
    const body = section(/^build/i);
    expect(body).toContain('npm ci');
    expect(body).toContain('npm run build');
    expect(body).toContain('dist/chrome');
    expect(body).toContain('dist/firefox');
  });

  it('should give Chrome install steps through Load unpacked if the Chrome section is read', () => {
    const body = section(/chrome/i);
    expect(body).toContain('chrome://extensions');
    expect(body).toMatch(/Developer mode/i);
    expect(body).toMatch(/Load unpacked/i);
    expect(body).toContain('dist/chrome');
    expect(body).toMatch(/Chrome\s*(>=|120|version 120)/);
  });

  it('should give Firefox install steps through about:debugging if the Firefox section is read (AC-003)', () => {
    const body = section(/firefox/i);
    expect(body).toContain('about:debugging');
    expect(body).toMatch(/Load Temporary Add-on/i);
    expect(body).toContain('dist/firefox/manifest.json');
    expect(body).toMatch(/Firefox\s*(>=|128|version 128)/);
  });

  it('should explain the popup, hide indicator, whitelist and options if the usage section is read', () => {
    const body = section(/usage/i);
    expect(body).toMatch(/popup/i);
    expect(body).toMatch(/Hidden by PureFeed/);
    expect(body).toContain('Show');
    expect(body).toContain('Always show this post');
    expect(body).toMatch(/Always show (<author>|@?author)/i);
    expect(body).toMatch(/whitelist/i);
    expect(body).toMatch(/options|settings/i);
    expect(body).toMatch(/Clear history/);
  });

  it('should state that all data stays local and nothing is sent out if the privacy section is read', () => {
    const body = section(/privacy/i);
    expect(body).toMatch(/IndexedDB/);
    expect(body).toMatch(/storage\.local/);
    expect(body).toMatch(/storage\.sync/);
    expect(body).toMatch(/telemetry|analytics/i);
    expect(body).toMatch(/no (data|information) (is )?(sent|leaves)|never sends|nothing leaves/i);
    expect(body).toMatch(/media URL/i);
  });

  it('should list every documented limit of spec 1.1, 1.2 and the Decision Log in the limitations section', () => {
    const items = bullets(section(/limitation/i));
    const missing = Object.entries(LIMITS)
      .filter(([, patterns]) => !items.some((item) => patterns.every((p) => p.test(item))))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('should list the manual smoke steps M1 to M8 if the manual smoke section is read', () => {
    const body = section(/manual smoke/i);
    for (const step of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']) expect(body, step).toMatch(new RegExp(`\\b${step}\\b`));
    expect(body).toContain('chrome://serviceworker-internals');
    expect(body).toContain('about:addons');
    expect(body).toMatch(/last confirmed/i);
  });
});

describe('README.md test map (AC-081, TC-104)', () => {
  it('should map each of the 8 ticket test categories to at least one existing test file', () => {
    const lines = bullets(section(/test map/i));
    const report = Object.entries(CATEGORIES).map(([name, pattern]) => {
      const files = lines.filter((line) => pattern.test(line)).flatMap(testFilesIn);
      return { name, files: files.length, missing: files.filter((f) => !existsSync(join(ROOT, f))) };
    });
    expect(report.filter((r) => r.files === 0).map((r) => r.name)).toEqual([]);
    expect(report.flatMap((r) => r.missing)).toEqual([]);
  });

  it('should map every acceptance criterion AC-001 to AC-081 to an existing test file or a manual smoke step', () => {
    const lines = bullets(section(/test map/i));
    const ids = Array.from({ length: 81 }, (_, i) => `AC-${String(i + 1).padStart(3, '0')}`);
    const unmapped = ids.filter((id) => {
      const rows = lines.filter((line) => new RegExp(`\\b${id}\\b`).test(line));
      return !rows.some((row) => testFilesIn(row).length > 0 || /\bM[1-8]\b/.test(row));
    });
    expect(unmapped).toEqual([]);
    const missing = lines.flatMap(testFilesIn).filter((f) => !existsSync(join(ROOT, f)));
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('README.md scope limits and test map content (AC-079, AC-081, TC-102, TC-104)', () => {
  it('should name the unsupported new.reddit.com legacy layout and twitter.com in the limitations section (spec 1.1)', () => {
    const items = bullets(section(/limitation/i));
    expect(items.some((item) => /new\.reddit\.com/.test(item))).toBe(true);
    expect(items.some((item) => /twitter\.com/.test(item))).toBe(true);
  });

  it('should map each ticket test category to a test file whose test titles cover that category', () => {
    const TOPICS: Record<string, RegExp> = {
      'fingerprint algorithms': /fingerprint|pHash|hash|edge map|crop/i,
      'similarity thresholds': /threshold|exact|near|similarity/i,
      'cross-platform detection': /seen on (Wykop|Reddit|X)|cross-platform|first seen on/i,
      'resize and compression': /resiz|recompress|quality|scale|convert/i,
      'video frame matching': /frame|video|GIF/i,
      'dynamic DOM changes': /insert|mutation|lazy|navigation|re-render|reuse|append/i,
      'false positives': /caption|screenshot|logo|different/i,
      'IndexedDB persistence': /IndexedDB|database|record|restart/i,
    };
    const lines = bullets(section(/test map/i));
    const titlesOf = (file: string): string[] =>
      [...readFileSync(join(ROOT, file), 'utf8').matchAll(/\b(?:it|test|describe)\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
    const uncovered = Object.entries(CATEGORIES)
      .filter(([name, pattern]) => {
        const files = lines.filter((line) => pattern.test(line)).flatMap(testFilesIn);
        return !files.some((file) => titlesOf(file).some((title) => TOPICS[name].test(title)));
      })
      .map(([name]) => name);
    expect(uncovered).toEqual([]);
    const empty = [...new Set(lines.flatMap(testFilesIn))].filter((file) => titlesOf(file).length === 0);
    expect(empty).toEqual([]);
  });
});
