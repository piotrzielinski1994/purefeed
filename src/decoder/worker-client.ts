import type { DecodeResult, GrayFrame } from '../shared/types.ts';

export type WorkerClient = {
  hashImage(bytes: ArrayBuffer, mime: string): Promise<DecodeResult>;
  hashFrames(frames: GrayFrame[], durationS: number): Promise<DecodeResult>;
};

export type WorkerJob = { op: 'image'; bytes: ArrayBuffer; mime: string } | { op: 'frames'; frames: GrayFrame[]; durationS: number };
export type WorkerRequest = { id: number; job: WorkerJob };
export type WorkerResponse = { id: number; result: DecodeResult };

export type WorkerPort = {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponse>) => void): void;
};

export function createWorkerClient(port: WorkerPort): WorkerClient {
  const pending = new Map<number, (result: DecodeResult) => void>();
  let lastId = 0;
  port.addEventListener('message', ({ data }) => {
    pending.get(data.id)?.(data.result);
    pending.delete(data.id);
  });
  const run = (job: WorkerJob, transfer: Transferable[]): Promise<DecodeResult> => {
    lastId += 1;
    const id = lastId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      port.postMessage({ id, job }, transfer);
    });
  };
  return {
    hashImage: (bytes, mime) => run({ op: 'image', bytes, mime }, [bytes]),
    hashFrames: (frames, durationS) => run({ op: 'frames', frames, durationS }, []),
  };
}
