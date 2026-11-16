import { ext } from '../compat/browser.ts';
import { onRequest } from '../compat/messaging.ts';
import { createCounters } from '../engine/counters.ts';
import { startRetention } from '../engine/retention.ts';
import { createSeenService } from '../engine/seen-service.ts';
import { createWhitelistStore } from '../engine/whitelist-store.ts';
import { openIdbSeenStore } from '../repository/idb-seen-store.ts';
import { createSeenRepository } from '../repository/seen-repository.ts';
import { createSettingsSource } from '../shared/settings.ts';
import type { SetTimer } from '../shared/types.ts';
import { createRouter } from './router.ts';

export function startBackground(): void {
  const setTimer: SetTimer = (fn, ms) => setTimeout(fn, ms);
  const storage = ext.storage.local;
  const settings = createSettingsSource({ storage, onChanged: ext.storage.onChanged });
  const counters = createCounters({ storage, now: Date.now, setTimer });
  const whitelist = createWhitelistStore({ storage });
  const repository = createSeenRepository({
    openStore: () => openIdbSeenStore(indexedDB),
    now: Date.now,
    setTimer,
    newId: () => crypto.randomUUID(),
  });
  const seen = createSeenService({ repository, settings, counters });
  const router = createRouter({ seen, counters, whitelist, repository, log: (m) => console.warn(m) });
  const ready = Promise.all([settings.ready, counters.ready, whitelist.ready]);
  onRequest(async (req, sender) => {
    await ready;
    return router(req, sender);
  });
  startRetention({ repository, settings, alarms: ext.alarms, setTimer });
}
