import { ext } from '../compat/browser.ts';
import type { DecoderHost } from './decoder-host.ts';
import { createMediaDecoder } from './media-decoder.ts';
import { createWorkerClient } from './worker-client.ts';

const HASH_WORKER_PATH = 'hash-worker.js';

export const createInProcessHost = (doc: Document): DecoderHost =>
  createMediaDecoder({
    doc,
    fetch: (input, init) => fetch(input, init),
    worker: createWorkerClient(new Worker(ext.runtime.getURL(HASH_WORKER_PATH))),
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
