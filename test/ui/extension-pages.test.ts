// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '../../src/background/router.ts';
import { createCounters } from '../../src/engine/counters.ts';
import { startRetention } from '../../src/engine/retention.ts';
import { createSeenService } from '../../src/engine/seen-service.ts';
import { createWhitelistStore } from '../../src/engine/whitelist-store.ts';
import { createSeenRepository } from '../../src/repository/seen-repository.ts';
import { createMemorySeenStore } from '../../src/repository/seen-store.ts';
import { HOST_PERMISSIONS } from '../../src/shared/hosts.ts';
import type { Request } from '../../src/shared/messages.ts';
import { createSettingsSource, DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import type { CounterValues, Settings, WhitelistEntry } from '../../src/shared/types.ts';
import { encodeFingerprint, encodeSighting } from '../../src/shared/wire.ts';
import { createFakeClock, createFakeExt, type FakeExt, settle } from '../helpers/fake-ext.ts';
import { DAY_MS, imageFp, randomHashes, sightingOf } from '../helpers/fingerprints.ts';

const UI_DIR = join(import.meta.dirname, '..', '..', 'src', 'ui');
const [HA] = randomHashes(1, 18019);
const THRESHOLD_ORDER = 'Similar threshold must be lower than exact threshold.';

const WHITELIST_MODULE = '../../src/shared/whitelist.ts';
const loadWhitelist = (): Promise<typeof import('../../src/shared/whitelist.ts')> => import(/* @vite-ignore */ WHITELIST_MODULE);

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const norm = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

type PageHost = Awaited<ReturnType<typeof createHost>>;

async function bootBackground(ext: FakeExt, storeFails: boolean) {
  const clock = createFakeClock(Date.now());
  const settings = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
  const counters = createCounters({ storage: ext.storage.local, now: clock.now, setTimer: clock.setTimer });
  const whitelist = createWhitelistStore({ storage: ext.storage.local });
  await Promise.all([settings.ready, counters.ready, whitelist.ready]);
  const repository = createSeenRepository({
    openStore: storeFails ? () => Promise.reject(new Error('QuotaExceededError')) : async () => createMemorySeenStore(),
    now: clock.now,
    setTimer: clock.setTimer,
    newId: () => crypto.randomUUID(),
  });
  const seen = createSeenService({ repository, settings, counters });
  const router = createRouter({ seen, counters, whitelist, repository, log: () => {} });
  startRetention({ repository, settings, alarms: ext.alarms, setTimer: clock.setTimer });
  const send = async (req: Request): Promise<unknown> => json(await router(json(req), { tabId: null, url: null }));
  return { clock, counters, whitelist, send };
}

async function createHost(
  opts: {
    settings?: Settings;
    counters?: CounterValues;
    whitelist?: WhitelistEntry[];
    storeFails?: boolean;
    granted?: boolean;
    grantAnswer?: boolean;
  } = {},
) {
  const ext = createFakeExt();
  const seed: Record<string, unknown> = {};
  if (opts.settings) seed.settings = opts.settings;
  if (opts.counters) seed.counters = opts.counters;
  if (opts.whitelist) seed.whitelist = opts.whitelist;
  if (Object.keys(seed).length > 0) await ext.storage.local.set(seed);
  await settle();
  const bg = await bootBackground(ext, opts.storeFails ?? false);
  const tab = createSettingsSource({ storage: ext.storage.local, onChanged: ext.storage.onChanged });
  await tab.ready;
  const origins = new Set<string>(opts.granted === false ? [] : HOST_PERMISSIONS);
  const permissionRequests: string[][] = [];
  const pageRequests: string[] = [];
  let held: Promise<void> | null = null;
  let optionsOpened = 0;
  const chrome = {
    runtime: {
      id: 'purefeed-test',
      sendMessage: async (message: unknown) => {
        const req = json(message) as Request;
        pageRequests.push(req.type);
        if (req.type === 'status/get' && held) await held;
        return bg.send(req);
      },
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path: string) => `chrome-extension://purefeed-test/${path}`,
      openOptionsPage: async () => {
        optionsOpened++;
      },
    },
    storage: { local: ext.storage.local, sync: ext.storage.sync, onChanged: ext.storage.onChanged },
    permissions: {
      contains: async (p: { origins?: string[] }) => (p.origins ?? []).every((o) => origins.has(o)),
      request: async (p: { origins?: string[] }) => {
        permissionRequests.push([...(p.origins ?? [])]);
        if (opts.grantAnswer !== false) for (const o of p.origins ?? []) origins.add(o);
        return opts.grantAnswer !== false;
      },
    },
    alarms: ext.alarms,
  };
  return {
    ext,
    bg,
    tab,
    chrome,
    permissionRequests,
    pageRequests,
    optionsOpened: () => optionsOpened,
    stored: (): Settings => ext.storage.local.dump().settings as Settings,
    holdStatus(): () => void {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
}

async function openPage(page: 'popup' | 'options', host: PageHost): Promise<void> {
  vi.resetModules();
  const html = readFileSync(join(UI_DIR, page, `${page}.html`), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  vi.stubGlobal('__TARGET__', 'chrome');
  vi.stubGlobal('chrome', host.chrome);
  if (page === 'popup') await import('../../src/ui/popup/popup.ts');
  else await import('../../src/ui/options/options.ts');
  await settle();
}

async function until(check: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    await settle();
    if (check()) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isShown(el: Element | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || (node as HTMLElement).style?.display === 'none')
      return false;
  }
  return true;
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (!isShown(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return '';
  if (el.tagName === 'SELECT') return ` ${(el as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''} `;
  return ` ${[...el.childNodes].map(visibleText).join('')} `;
}

const pageText = (): string => norm(visibleText(document.body));

const CONTROL =
  'button, input, select, textarea, a[href], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="button"]';

function nameOf(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (ids)
    return norm(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    );
  const aria = el.getAttribute('aria-label');
  if (aria) return norm(aria);
  const labels = [...document.querySelectorAll('label')].filter((l) => (el.id !== '' && l.htmlFor === el.id) || l.contains(el));
  if (labels.length > 0) return norm(labels.map((l) => visibleText(l)).join(' '));
  if (el.matches('input, select, textarea')) return norm(el.getAttribute('title'));
  return norm(el.textContent);
}

const controls = (): Element[] =>
  [...document.body.querySelectorAll(CONTROL)].filter((el) => isShown(el) && (el as HTMLInputElement).type !== 'hidden');

function control(name: RegExp, filter: (el: Element) => boolean = () => true): HTMLElement {
  const found = controls().find((el) => filter(el) && name.test(nameOf(el)));
  if (!found) throw new Error(`no control named ${name}; shown controls: ${JSON.stringify(controls().map(nameOf))}`);
  return found as HTMLElement;
}

const isToggleEl = (el: Element): boolean =>
  (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') ||
  ['switch', 'checkbox'].includes(el.getAttribute('role') ?? '') ||
  el.hasAttribute('aria-pressed');

const toggle = (name: RegExp): HTMLElement => control(name, isToggleEl);
const toggles = (): Element[] => controls().filter(isToggleEl);
const button = (name: RegExp): HTMLElement =>
  control(name, (el) => el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button');
const isOn = (el: Element): boolean =>
  el.tagName === 'INPUT'
    ? (el as HTMLInputElement).checked
    : el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
const isDisabled = (el: Element): boolean =>
  (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]') !== null;

const MASTER = /purefeed|deduplication|enable/i;
const PLATFORM_TOGGLES = { reddit: /^reddit\b/i, wykop: /^wykop\b/i, x: /^x\b/i } as const;

function setValue(el: HTMLElement, value: string): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function choose(select: HTMLElement, option: RegExp): void {
  const el = select as HTMLSelectElement;
  const match = [...el.options].find((o) => option.test(norm(o.textContent)));
  if (!match) throw new Error(`no option ${option} in ${JSON.stringify([...el.options].map((o) => o.textContent))}`);
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const optionTexts = (select: HTMLElement): string[] => [...(select as HTMLSelectElement).options].map((o) => norm(o.textContent));
const selectedText = (select: HTMLElement): string => norm((select as HTMLSelectElement).selectedOptions[0]?.textContent);

function whitelistPlatformSelect(): HTMLElement {
  return control(/.*/, (el) => el.tagName === 'SELECT' && optionTexts(el as HTMLElement).some((t) => /^reddit$/i.test(t)));
}

function whitelistTextInput(): HTMLInputElement {
  const inputs = controls().filter((el) => el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.getAttribute('type') ?? ''));
  expect(inputs, 'the options page has exactly one text input (whitelist entry)').toHaveLength(1);
  return inputs[0] as HTMLInputElement;
}

function removeButtonFor(key: string): HTMLElement {
  const removes = controls().filter((el) => el.tagName === 'BUTTON' && /^remove\b/i.test(nameOf(el)));
  for (const btn of removes) {
    let row: Element = btn;
    while (row.parentElement && row.parentElement.querySelectorAll('button').length === 1) row = row.parentElement;
    if (row !== btn && norm(row.textContent).includes(key)) return btn as HTMLElement;
    if (row === btn && nameOf(btn).includes(key)) return btn as HTMLElement;
  }
  throw new Error(`no Remove button for ${key}`);
}

async function addSource(platform: RegExp, text: string): Promise<void> {
  choose(whitelistPlatformSelect(), platform);
  const input = whitelistTextInput();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  button(/^add\b/i).click();
  await settle();
}

const record = (host: PageHost) => host.bg.send({ type: 'seen/record', sighting: encodeSighting(sightingOf(imageFp(HA))) });
const lookupA = async (host: PageHost) =>
  ((await host.bg.send({ type: 'seen/lookup', fingerprints: [encodeFingerprint(imageFp(HA))] })) as { matches: unknown[] }).matches[0];

let confirmAnswer = true;
const confirmMock = vi.fn(() => confirmAnswer);

function stubConfirm(answer: boolean): void {
  confirmAnswer = answer;
  confirmMock.mockClear();
  vi.stubGlobal('confirm', confirmMock);
  window.confirm = confirmMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

describe('popup (AC-040, AC-062, AC-064, AC-065, AC-069)', () => {
  it('should show every AC-062 item with default settings and the empty hint if both counters are 0 (TC-082)', async () => {
    const host = await createHost();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    const text = pageText();
    expect(text).toMatch(/Duplicates hidden 0(?![\d,])/);
    expect(text).toMatch(/Unique items processed 0(?![\d,])/);
    expect(text).toMatch(/Threshold Similar >= 90%/);
    expect(text).toMatch(/Retention 30 days/);
    expect(text).toContain('No items yet. Open Reddit, Wykop or X.');
    expect(isOn(toggle(MASTER))).toBe(true);
    for (const name of Object.values(PLATFORM_TOGGLES)) {
      expect(isOn(toggle(name)), String(name)).toBe(true);
      expect(isDisabled(toggle(name)), String(name)).toBe(false);
    }
    expect(button(/^open settings$/i)).toBeTruthy();
  });

  it('should show the label Exact >= 95% if the stored mode is exact only (TC-082)', async () => {
    const host = await createHost({ settings: { ...DEFAULT_SETTINGS, mode: 'exact' } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Threshold'))).toBe(true);
    expect(pageText()).toMatch(/Threshold Exact >= 95%/);
    expect(pageText()).not.toContain('Similar >=');
  });

  it('should show the stored counters with thousands separators and no empty hint', async () => {
    const host = await createHost({ counters: { duplicatesHidden: 1284, uniqueItems: 18902 } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('1,284'))).toBe(true);
    expect(pageText()).toMatch(/Duplicates hidden 1,284/);
    expect(pageText()).toMatch(/Unique items processed 18,902/);
    expect(pageText()).not.toContain('No items yet.');
  });

  it('should show Loading statistics with disabled toggles until the counters arrive', async () => {
    const host = await createHost({ counters: { duplicatesHidden: 7, uniqueItems: 9 } });
    const release = host.holdStatus();
    await openPage('popup', host);
    await until(() => false, 100);
    expect(pageText()).toContain('Loading statistics...');
    expect(pageText()).not.toContain('Duplicates hidden');
    for (const name of Object.values(PLATFORM_TOGGLES)) {
      expect(isDisabled(toggle(name)), String(name)).toBe(true);
    }
    expect(button(/^open settings$/i)).toBeTruthy();
    release();
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    expect(pageText()).not.toContain('Loading statistics...');
    expect(pageText()).toMatch(/Duplicates hidden 7(?![\d,])/);
    expect(isDisabled(toggle(PLATFORM_TOGGLES.reddit))).toBe(false);
  });

  it('should save the master toggle in storage.local at once and reach open tabs through storage.onChanged (TC-083)', async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, mode: 'exact', retentionDays: 90 };
    const host = await createHost({ settings: stored });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    toggle(MASTER).click();
    expect(await until(() => host.tab.get().enabled === false)).toBe(true);
    expect(host.stored()).toEqual({ ...stored, enabled: false });
    expect(host.ext.storage.sync.dump()).toEqual({});
    expect(host.ext.storage.sync.setCalls).toBe(0);
    expect(controls().some((el) => /^save\b/i.test(nameOf(el)))).toBe(false);
  });

  it('should show the Disabled state with counters and disabled platform toggles if the master toggle is off', async () => {
    const host = await createHost({ counters: { duplicatesHidden: 1284, uniqueItems: 18902 } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('1,284'))).toBe(true);
    expect(pageText()).not.toContain('Deduplication is off.');
    toggle(MASTER).click();
    expect(await until(() => pageText().includes('Deduplication is off. No post is hidden.'))).toBe(true);
    expect(isOn(toggle(MASTER))).toBe(false);
    expect(isDisabled(toggle(MASTER))).toBe(false);
    expect(pageText()).toMatch(/Duplicates hidden 1,284/);
    for (const name of Object.values(PLATFORM_TOGGLES)) {
      expect(isDisabled(toggle(name)), String(name)).toBe(true);
    }
    toggle(MASTER).click();
    expect(await until(() => host.tab.get().enabled === true && !pageText().includes('Deduplication is off.'))).toBe(true);
    expect(isDisabled(toggle(PLATFORM_TOGGLES.wykop))).toBe(false);
  });

  it('should open the Disabled state if the stored master toggle is off', async () => {
    const host = await createHost({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Deduplication is off. No post is hidden.'))).toBe(true);
    expect(isOn(toggle(MASTER))).toBe(false);
    expect(isDisabled(toggle(PLATFORM_TOGGLES.x))).toBe(true);
  });

  it('should save a platform toggle in storage.local and keep the other settings (TC-085)', async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, nearThreshold: 85, toast: false };
    const host = await createHost({ settings: stored });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    toggle(PLATFORM_TOGGLES.reddit).click();
    expect(await until(() => host.tab.get().platforms.reddit === false)).toBe(true);
    expect(host.stored()).toEqual({ ...stored, platforms: { reddit: false, wykop: true, x: true } });
    expect(isOn(toggle(PLATFORM_TOGGLES.reddit))).toBe(false);
    expect(isOn(toggle(PLATFORM_TOGGLES.wykop))).toBe(true);
    toggle(PLATFORM_TOGGLES.x).click();
    expect(await until(() => host.tab.get().platforms.x === false)).toBe(true);
    expect(host.stored().platforms).toEqual({ reddit: false, wykop: true, x: false });
  });

  it('should keep a retention change made in the popup after the popup closes and reopens, with nothing in storage.sync (TC-084)', async () => {
    const host = await createHost();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Retention'))).toBe(true);
    const retention = control(/^retention\b/i, (el) => el.tagName === 'SELECT');
    choose(retention, /^90 days$/);
    expect(await until(() => host.tab.get().retentionDays === 90)).toBe(true);
    expect(host.stored()).toEqual({ ...DEFAULT_SETTINGS, retentionDays: 90 });
    document.body.replaceChildren();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Retention'))).toBe(true);
    expect(selectedText(control(/^retention\b/i, (el) => el.tagName === 'SELECT'))).toBe('90 days');
    expect(host.ext.storage.sync.dump()).toEqual({});
    expect(host.ext.storage.sync.setCalls).toBe(0);
  });

  it('should show the history-not-saved warning above the counters if IndexedDB failed and keep the toggles working (TC-056)', async () => {
    const host = await createHost({ storeFails: true, counters: { duplicatesHidden: 12, uniqueItems: 40 } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('History not saved: local storage failed.'))).toBe(true);
    const text = pageText();
    expect(text).toContain('Detection works for this session only.');
    expect(text.indexOf('History not saved')).toBeLessThan(text.indexOf('Duplicates hidden'));
    expect(text).toMatch(/Duplicates hidden 12(?![\d,])/);
    expect(text).toMatch(/Unique items processed 40(?![\d,])/);
    expect(isDisabled(toggle(PLATFORM_TOGGLES.wykop))).toBe(false);
    toggle(PLATFORM_TOGGLES.wykop).click();
    expect(await until(() => host.tab.get().platforms.wykop === false)).toBe(true);
  });

  it('should not show the history-not-saved warning if IndexedDB works', async () => {
    const host = await createHost({ counters: { duplicatesHidden: 12, uniqueItems: 40 } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    expect(pageText()).not.toContain('History not saved');
  });

  it('should show only the Permission needed message and Grant access if host permissions are missing, and the normal popup after grant (TC-089)', async () => {
    const host = await createHost({ granted: false, counters: { duplicatesHidden: 3, uniqueItems: 5 } });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Grant access'))).toBe(true);
    expect(pageText()).toContain('PureFeed needs access to Reddit, Wykop and X to detect duplicates.');
    expect(pageText()).not.toContain('Duplicates hidden');
    expect(toggles().filter((el) => Object.values(PLATFORM_TOGGLES).some((re) => re.test(nameOf(el))))).toEqual([]);
    button(/^grant access$/i).click();
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    expect(host.permissionRequests).toHaveLength(1);
    expect(host.permissionRequests[0]).toEqual(expect.arrayContaining([...HOST_PERMISSIONS]));
    expect(pageText()).not.toContain('Grant access');
    expect(pageText()).toMatch(/Duplicates hidden 3(?![\d,])/);
    expect(isOn(toggle(PLATFORM_TOGGLES.reddit))).toBe(true);
  });

  it('should stay in the Permission needed state if the user denies the grant (TC-089)', async () => {
    const host = await createHost({ granted: false, grantAnswer: false });
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Grant access'))).toBe(true);
    button(/^grant access$/i).click();
    await until(() => false, 100);
    expect(host.permissionRequests).toHaveLength(1);
    expect(pageText()).toContain('PureFeed needs access to Reddit, Wykop and X to detect duplicates.');
    expect(pageText()).not.toContain('Duplicates hidden');
  });

  it('should open the options page from Open settings', async () => {
    const host = await createHost();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    button(/^open settings$/i).click();
    await settle();
    expect(host.optionsOpened()).toBe(1);
  });

  it('should give every popup control an accessible name and keyboard focus', async () => {
    const host = await createHost();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    expect(controls().length).toBeGreaterThanOrEqual(5);
    for (const el of controls()) {
      expect(nameOf(el), el.outerHTML).not.toBe('');
      expect((el as HTMLElement).tabIndex, el.outerHTML).toBeGreaterThanOrEqual(0);
      (el as HTMLElement).focus();
      expect(document.activeElement, el.outerHTML).toBe(el);
    }
  });
});

describe('options page (AC-038, AC-041, AC-056, AC-064, AC-066, AC-067, AC-068)', () => {
  async function openOptions(opts: Parameters<typeof createHost>[0] = {}): Promise<PageHost> {
    const host = await createHost(opts);
    stubConfirm(true);
    await openPage('options', host);
    expect(await until(() => controls().some((el) => /^exact threshold/i.test(nameOf(el))))).toBe(true);
    return host;
  }

  it('should hold every AC-067 control, labeled, with the default values (TC-087)', async () => {
    await openOptions();
    const text = pageText();
    for (const section of ['Detection', 'Platforms', 'History', 'Whitelist', 'Privacy and limitations']) {
      expect(text, section).toContain(section);
    }
    expect(isOn(control(/^exact and similar$/i))).toBe(true);
    expect(isOn(control(/^exact only$/i))).toBe(false);
    expect((control(/^exact threshold/i) as HTMLInputElement).value).toBe('95');
    expect((control(/^similar threshold/i) as HTMLInputElement).value).toBe('90');
    for (const name of [
      /^images?\b/i,
      /^gifs?\b/i,
      /^videos?\b/i,
      PLATFORM_TOGGLES.reddit,
      PLATFORM_TOGGLES.wykop,
      PLATFORM_TOGGLES.x,
      /toast/i,
    ]) {
      expect(isOn(toggle(name)), String(name)).toBe(true);
    }
    const retention = control(/^retention\b/i, (el) => el.tagName === 'SELECT');
    expect(optionTexts(retention)).toEqual(['7 days', '30 days', '90 days', expect.stringMatching(/^forever$/i)]);
    expect(selectedText(retention)).toBe('30 days');
    expect(button(/^clear history$/i)).toBeTruthy();
    expect(button(/^reset counters$/i)).toBeTruthy();
    expect(optionTexts(whitelistPlatformSelect()).map((t) => t.toLowerCase())).toEqual(['reddit', 'wykop', 'x']);
    expect(whitelistTextInput()).toBeTruthy();
    expect(button(/^add\b/i)).toBeTruthy();
    expect(text).toContain('All processing is local. Nothing leaves this browser.');
    expect(text).toMatch(/Known limitations/);
    expect(controls().some((el) => /^save\b/i.test(nameOf(el)))).toBe(false);
  });

  it('should show the stored non-default settings', async () => {
    await openOptions({
      settings: {
        ...DEFAULT_SETTINGS,
        mode: 'exact',
        exactThreshold: 97,
        nearThreshold: 80,
        retentionDays: null,
        platforms: { reddit: true, wykop: true, x: false },
        contentTypes: { image: true, gif: true, video: false },
        toast: false,
      },
    });
    expect(isOn(control(/^exact only$/i))).toBe(true);
    expect((control(/^exact threshold/i) as HTMLInputElement).value).toBe('97');
    expect((control(/^similar threshold/i) as HTMLInputElement).value).toBe('80');
    expect(isOn(toggle(/^videos?\b/i))).toBe(false);
    expect(isOn(toggle(/^images?\b/i))).toBe(true);
    expect(isOn(toggle(PLATFORM_TOGGLES.x))).toBe(false);
    expect(isOn(toggle(/toast/i))).toBe(false);
    expect(selectedText(control(/^retention\b/i, (el) => el.tagName === 'SELECT'))).toMatch(/^forever$/i);
  });

  it('should save the mode at once in storage.local only and reach open tabs through storage.onChanged (AC-064)', async () => {
    const host = await openOptions();
    control(/^exact only$/i).click();
    expect(await until(() => host.tab.get().mode === 'exact')).toBe(true);
    expect(host.stored()).toEqual({ ...DEFAULT_SETTINGS, mode: 'exact' });
    control(/^exact and similar$/i).click();
    expect(await until(() => host.tab.get().mode === 'exact-near')).toBe(true);
    expect(host.ext.storage.sync.dump()).toEqual({});
    expect(host.ext.storage.sync.setCalls).toBe(0);
  });

  it('should save valid exact and similar thresholds from the sliders', async () => {
    const host = await openOptions();
    setValue(control(/^exact threshold/i), '97');
    expect(await until(() => host.tab.get().exactThreshold === 97)).toBe(true);
    setValue(control(/^similar threshold/i), '85');
    expect(await until(() => host.tab.get().nearThreshold === 85)).toBe(true);
    expect(host.stored()).toEqual({ ...DEFAULT_SETTINGS, exactThreshold: 97, nearThreshold: 85 });
    expect(pageText()).not.toContain(THRESHOLD_ORDER);
  });

  it('should show the inline error and keep the stored value if the similar threshold reaches the exact threshold (TC-088)', async () => {
    const stored: Settings = { ...DEFAULT_SETTINGS, exactThreshold: 90, nearThreshold: 85 };
    const host = await openOptions({ settings: stored });
    setValue(control(/^similar threshold/i), '92');
    expect(await until(() => pageText().includes(THRESHOLD_ORDER))).toBe(true);
    await until(() => false, 100);
    expect(host.stored()).toEqual(stored);
    expect(host.tab.get().nearThreshold).toBe(85);
    setValue(control(/^similar threshold/i), '80');
    expect(await until(() => host.tab.get().nearThreshold === 80)).toBe(true);
    expect(pageText()).not.toContain(THRESHOLD_ORDER);
  });

  it('should show the inline error and keep the stored value if the exact threshold is lowered to the similar threshold (TC-088)', async () => {
    const host = await openOptions();
    setValue(control(/^exact threshold/i), '90');
    expect(await until(() => pageText().includes(THRESHOLD_ORDER))).toBe(true);
    await until(() => false, 100);
    expect(host.stored()).toBeUndefined();
    expect(host.tab.get().exactThreshold).toBe(95);
  });

  it('should save each content type toggle under its own type (AC-066)', async () => {
    const host = await openOptions();
    toggle(/^videos?\b/i).click();
    expect(await until(() => host.tab.get().contentTypes.video === false)).toBe(true);
    expect(host.stored().contentTypes).toEqual({ image: true, gif: true, video: false });
    toggle(/^gifs?\b/i).click();
    expect(await until(() => host.tab.get().contentTypes.gif === false)).toBe(true);
    toggle(/^images?\b/i).click();
    expect(await until(() => host.tab.get().contentTypes.image === false)).toBe(true);
    expect(host.stored()).toEqual({ ...DEFAULT_SETTINGS, contentTypes: { image: false, gif: false, video: false } });
  });

  it('should save each platform toggle and the toast toggle', async () => {
    const host = await openOptions();
    toggle(PLATFORM_TOGGLES.wykop).click();
    expect(await until(() => host.tab.get().platforms.wykop === false)).toBe(true);
    toggle(/toast/i).click();
    expect(await until(() => host.tab.get().toast === false)).toBe(true);
    expect(host.stored()).toEqual({ ...DEFAULT_SETTINGS, platforms: { reddit: true, wykop: false, x: true }, toast: false });
  });

  it('should save retention 7, 90, forever and 30 days from the retention select', async () => {
    const host = await openOptions();
    const retention = () => control(/^retention\b/i, (el) => el.tagName === 'SELECT');
    choose(retention(), /^7 days$/);
    expect(await until(() => host.tab.get().retentionDays === 7)).toBe(true);
    choose(retention(), /^90 days$/);
    expect(await until(() => host.tab.get().retentionDays === 90)).toBe(true);
    choose(retention(), /^forever$/i);
    expect(await until(() => host.tab.get().retentionDays === null)).toBe(true);
    expect(host.stored().retentionDays).toBeNull();
    choose(retention(), /^30 days$/);
    expect(await until(() => host.tab.get().retentionDays === 30)).toBe(true);
    expect(host.stored()).toEqual(DEFAULT_SETTINGS);
  });

  it('should delete records older than 30 days within 5 s if retention changes from forever to 30 days (TC-053)', async () => {
    const host = await openOptions({ settings: { ...DEFAULT_SETTINGS, retentionDays: null } });
    await record(host);
    host.bg.clock.set(host.bg.clock.now() + 31 * DAY_MS);
    expect(await lookupA(host)).not.toBeNull();
    choose(
      control(/^retention\b/i, (el) => el.tagName === 'SELECT'),
      /^30 days$/,
    );
    expect(await until(() => host.tab.get().retentionDays === 30)).toBe(true);
    await host.bg.clock.advance(5000);
    expect(await lookupA(host)).toBeNull();
  });

  it('should delete all seen records after Clear history is confirmed and keep them if the dialog is cancelled (TC-057)', async () => {
    const host = await openOptions();
    await record(host);
    stubConfirm(false);
    button(/^clear history$/i).click();
    await until(() => false, 100);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(await lookupA(host)).not.toBeNull();
    expect(host.pageRequests).not.toContain('history/clear');
    stubConfirm(true);
    button(/^clear history$/i).click();
    expect(await until(() => host.pageRequests.includes('history/clear'))).toBe(true);
    await settle();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(await lookupA(host)).toBeNull();
  });

  it('should set both counters to 0 with Reset counters so the popup shows 0 and 0 (TC-058)', async () => {
    const host = await openOptions({ counters: { duplicatesHidden: 12, uniqueItems: 40 } });
    button(/^reset counters$/i).click();
    expect(await until(() => host.bg.counters.get().duplicatesHidden === 0)).toBe(true);
    expect(host.bg.counters.get()).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
    expect(host.ext.storage.local.dump().counters).toEqual({ duplicatesHidden: 0, uniqueItems: 0 });
    document.body.replaceChildren();
    await openPage('popup', host);
    expect(await until(() => pageText().includes('Duplicates hidden'))).toBe(true);
    expect(pageText()).toMatch(/Duplicates hidden 0(?![\d,])/);
    expect(pageText()).toMatch(/Unique items processed 0(?![\d,])/);
  });

  it('should list every whitelist entry with its type and remove one entry (AC-056)', async () => {
    const post: WhitelistEntry = { type: 'post', key: 'reddit:t3_1abc2d' };
    const source: WhitelistEntry = { type: 'source', key: 'x:@somehandle' };
    const host = await openOptions({ whitelist: [post, source] });
    expect(await until(() => pageText().includes('x:@somehandle'))).toBe(true);
    expect(pageText()).toMatch(/Post reddit:t3_1abc2d/i);
    expect(pageText()).toMatch(/Source x:@somehandle/i);
    removeButtonFor('x:@somehandle').click();
    expect(await until(() => !pageText().includes('x:@somehandle'))).toBe(true);
    expect(host.bg.whitelist.list()).toEqual([post]);
    expect(host.ext.storage.local.dump().whitelist).toEqual([post]);
    expect(pageText()).toContain('reddit:t3_1abc2d');
  });

  it('should add a typed Reddit subreddit, Wykop author and X handle as source entries (TC-075)', async () => {
    const host = await openOptions();
    await addSource(/^reddit$/i, 'r/memes');
    expect(await until(() => pageText().includes('reddit:r/memes'))).toBe(true);
    await addSource(/^wykop$/i, '@pf_author');
    expect(await until(() => pageText().includes('wykop:@pf_author'))).toBe(true);
    await addSource(/^x$/i, '@somehandle');
    expect(await until(() => pageText().includes('x:@somehandle'))).toBe(true);
    const expected: WhitelistEntry[] = [
      { type: 'source', key: 'reddit:r/memes' },
      { type: 'source', key: 'wykop:@pf_author' },
      { type: 'source', key: 'x:@somehandle' },
    ];
    expect(host.bg.whitelist.list()).toEqual(expected);
    expect(host.ext.storage.local.dump().whitelist).toEqual(expected);
  });

  it('should show an inline error and save nothing if the typed source has no prefix (TC-076)', async () => {
    const { parseSourceInput } = await loadWhitelist();
    const invalid = parseSourceInput('reddit', 'memes');
    const message = invalid.ok ? '' : invalid.message;
    const existing: WhitelistEntry = { type: 'post', key: 'reddit:t3_1abc2d' };
    const host = await openOptions({ whitelist: [existing] });
    await addSource(/^reddit$/i, 'memes');
    expect(await until(() => pageText().includes(message))).toBe(true);
    expect(message).not.toBe('');
    expect(host.pageRequests).not.toContain('whitelist/add');
    expect(host.bg.whitelist.list()).toEqual([existing]);
    expect(host.ext.storage.local.dump().whitelist).toEqual([existing]);
    expect(pageText()).not.toContain('reddit:memes');
  });

  it('should reject an @name for Reddit with an inline error', async () => {
    const { parseSourceInput } = await loadWhitelist();
    const invalid = parseSourceInput('reddit', '@memes');
    const host = await openOptions();
    await addSource(/^reddit$/i, '@memes');
    expect(await until(() => !invalid.ok && pageText().includes(invalid.message))).toBe(true);
    expect(host.pageRequests).not.toContain('whitelist/add');
    expect(host.ext.storage.local.dump().whitelist).toBeUndefined();
    expect(pageText()).not.toContain('reddit:@memes');
  });

  it('should give every options control an accessible name and keyboard focus', async () => {
    await openOptions({ whitelist: [{ type: 'source', key: 'x:@somehandle' }] });
    expect(await until(() => pageText().includes('x:@somehandle'))).toBe(true);
    expect(controls().length).toBeGreaterThanOrEqual(17);
    for (const el of controls()) {
      expect(nameOf(el), el.outerHTML).not.toBe('');
      expect((el as HTMLElement).tabIndex, el.outerHTML).toBeGreaterThanOrEqual(0);
      (el as HTMLElement).focus();
      expect(document.activeElement, el.outerHTML).toBe(el);
    }
  });
});
