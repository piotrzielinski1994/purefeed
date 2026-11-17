import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMediaService } from '../../src/background/media-service.ts';
import { createRouter } from '../../src/background/router.ts';
import type { sendRequest } from '../../src/compat/messaging.ts';
import { runJob, type ToGray } from '../../src/decoder/hash-jobs.ts';
import { createMediaDecoder } from '../../src/decoder/media-decoder.ts';
import { createWorkerClient, type WorkerPort, type WorkerResponse } from '../../src/decoder/worker-client.ts';
import { createCounters } from '../../src/engine/counters.ts';
import { createSeenService } from '../../src/engine/seen-service.ts';
import { createWhitelistStore } from '../../src/engine/whitelist-store.ts';
import { createSeenRepository } from '../../src/repository/seen-repository.ts';
import { createMemorySeenStore } from '../../src/repository/seen-store.ts';
import type { Request } from '../../src/shared/messages.ts';
import { createSettingsSource } from '../../src/shared/settings.ts';
import { assetPath, loadGray } from './assets.ts';
import { createFakeExt, type FakeClock } from './fake-ext.ts';
import { createMediaFakes, type FakeRoute } from './fake-media.ts';

const SENDER = { tabId: 1, url: 'https://www.reddit.com/' };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function inProcessWorkerPort(routes: Record<string, FakeRoute>): WorkerPort & { jobs: string[] } {
  const grayByHash = new Map(
    Object.values(routes).flatMap((route) =>
      'asset' in route ? [[sha256(new Uint8Array(readFileSync(assetPath(route.asset)))), route.asset] as const] : [],
    ),
  );
  const toGray: ToGray = async (bytes) => {
    const name = grayByHash.get(sha256(new Uint8Array(bytes)));
    if (!name) throw new Error('unknown image bytes');
    return loadGray(name);
  };
  const listeners: Array<(event: MessageEvent<WorkerResponse>) => void> = [];
  const jobs: string[] = [];
  return {
    jobs,
    postMessage: ({ id, job }) => {
      jobs.push(job.op);
      runJob(job, toGray).then((result) => {
        listeners.forEach((listener) => {
          listener({ data: { id, result } } as MessageEvent<WorkerResponse>);
        });
      });
    },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
}

export async function createRealBackground(opts: { routes: Record<string, FakeRoute>; clock: FakeClock }) {
  const ext = createFakeExt();
  const storage = ext.storage.local;
  const settings = createSettingsSource({ storage, onChanged: ext.storage.onChanged });
  const counters = createCounters({ storage, now: opts.clock.now, setTimer: opts.clock.setTimer });
  const whitelist = createWhitelistStore({ storage });
  await Promise.all([settings.ready, counters.ready, whitelist.ready]);
  let lastId = 0;
  const repository = createSeenRepository({
    openStore: async () => createMemorySeenStore(),
    now: opts.clock.now,
    setTimer: opts.clock.setTimer,
    newId: () => {
      lastId += 1;
      return `rec-${lastId}`;
    },
  });
  const port = inProcessWorkerPort(opts.routes);
  const fakes = createMediaFakes(opts.routes);
  const decoder = createMediaDecoder({
    doc: document,
    fetch: fakes.fetch,
    worker: createWorkerClient(port),
    now: opts.clock.now,
    setTimer: opts.clock.setTimer,
  });
  const router = createRouter({
    seen: createSeenService({ repository, settings, counters }),
    counters,
    whitelist,
    repository,
    media: createMediaService(decoder),
    log: () => undefined,
  });
  const exchanges: Array<{ req: Request; res: unknown }> = [];
  const send = (async (req: Request) => {
    const res = json(await router(json(req), SENDER));
    exchanges.push({ req: json(req), res });
    return res;
  }) as unknown as typeof sendRequest;
  const responsesOf = (type: Request['type']) => exchanges.filter((e) => e.req.type === type).map((e) => e.res);
  return { send, exchanges, responsesOf, fetchCalls: fakes.calls, workerJobs: port.jobs, repository };
}
