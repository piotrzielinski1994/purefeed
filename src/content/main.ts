import { adapterForHost } from '../adapters/registry.ts';
import { ext } from '../compat/browser.ts';
import { sendRequest } from '../compat/messaging.ts';
import { WHITELIST_KEY } from '../engine/whitelist-store.ts';
import { createSettingsSource } from '../shared/settings.ts';
import { whitelistEntries } from '../shared/whitelist.ts';
import { createContentRuntime } from './runtime.ts';

const whitelistKeys = (stored: unknown): ReadonlySet<string> => new Set(whitelistEntries(stored).map((e) => e.key));

const adapter = adapterForHost(location.host);

if (adapter) {
  const storage = ext.storage.local;
  const settings = createSettingsSource({ storage, onChanged: ext.storage.onChanged });
  let whitelist = whitelistKeys(undefined);
  const runtime = createContentRuntime({
    adapter,
    doc: document,
    win: window,
    send: (req) => {
      if (ext.runtime.id === undefined) {
        runtime.stop();
        return Promise.reject(new Error('PureFeed: extension context invalidated'));
      }
      return sendRequest(req);
    },
    createObserver: (cb, init) => new IntersectionObserver(cb, init),
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => {
      if (typeof id === 'number') {
        clearTimeout(id);
      }
    },
    isWhitelisted: (key) => whitelist.has(key),
  });
  settings.onChange((next) => {
    runtime.reevaluateAll(next);
  });
  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.hasOwn(changes, WHITELIST_KEY)) {
      whitelist = whitelistKeys(changes[WHITELIST_KEY].newValue);
      runtime.reevaluateAll(settings.get());
    }
  });
  const storedWhitelist = storage.get(WHITELIST_KEY).then((items) => {
    whitelist = whitelistKeys(items[WHITELIST_KEY]);
  });
  Promise.all([settings.ready, storedWhitelist]).then(() => {
    runtime.reevaluateAll(settings.get());
    runtime.start();
  });
}
