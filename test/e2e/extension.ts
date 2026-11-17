import { join } from 'node:path';
import { type BrowserContext, test as base, chromium, type Page, type Worker } from '@playwright/test';
import { MEDIA_HOSTS, PLATFORM_HOSTS } from '../../src/shared/hosts.ts';
import type { Request, RequestType, ResponseOf } from '../../src/shared/messages.ts';
import { type FixtureServer, startFixtureServer } from './server.ts';

export const EXTENSION_DIR = join(import.meta.dirname, '..', '..', 'dist', 'chrome');
export const EXTRA_HOSTS = ['media2.test'] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type SendRequest = <K extends RequestType>(req: Extract<Request, { type: K }>, timeoutMs?: number) => Promise<ResponseOf<K>>;

type ExtensionFixtures = {
  server: FixtureServer;
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  extensionPage: Page;
  send: SendRequest;
};

export const hostResolverRules = (port: number): string =>
  [...new Set([...PLATFORM_HOSTS, ...MEDIA_HOSTS, ...EXTRA_HOSTS])].map((host) => `MAP ${host} 127.0.0.1:${port}`).join(', ');

export async function sendFromPage<K extends RequestType>(
  page: Page,
  req: Extract<Request, { type: K }>,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ResponseOf<K>> {
  return page.evaluate(
    ([message, ms]) => {
      const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime;
      return Promise.race([
        runtime.sendMessage(message),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no response to ${message.type} within ${ms} ms`)), ms)),
      ]);
    },
    [req, timeoutMs] as const,
  ) as Promise<ResponseOf<K>>;
}

type WorkerVersion = { runningStatus: string; scriptURL: string };

export async function stopServiceWorkers(context: BrowserContext, page: Page, timeoutMs = 15_000): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const stopped = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`service worker not stopped within ${timeoutMs} ms`)), timeoutMs);
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }: { versions: WorkerVersion[] }) => {
        if (versions.some((v) => v.scriptURL.endsWith('/background.js') && v.runningStatus === 'stopped')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await stopped;
  } finally {
    await cdp.detach();
  }
}

export const extensionTest = base.extend<ExtensionFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument
  server: async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  },
  context: async ({ server }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        `--host-resolver-rules=${hostResolverRules(server.port)}`,
        '--ignore-certificate-errors',
      ],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  extensionPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await use(page);
  },
  send: async ({ extensionPage }, use) => {
    await use((req, timeoutMs) => sendFromPage(extensionPage, req, timeoutMs));
  },
});

export { expect } from '@playwright/test';
