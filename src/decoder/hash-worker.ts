import { rgbaToGray } from '../fingerprint/gray.ts';
import type { GrayImage } from '../shared/types.ts';
import { runJob } from './hash-jobs.ts';
import type { WorkerRequest, WorkerResponse } from './worker-client.ts';

const NORMALIZED_SIZE = 256;

async function toGray(bytes: ArrayBuffer, mime: string): Promise<GrayImage> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const context = new OffscreenCanvas(NORMALIZED_SIZE, NORMALIZED_SIZE).getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('PureFeed: no 2D context in the hash worker');
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
  bitmap.close();
  return rgbaToGray(context.getImageData(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE).data, NORMALIZED_SIZE, NORMALIZED_SIZE);
}

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, job } = event.data;
  runJob(job, toGray).then((result) => postMessage({ id, result } satisfies WorkerResponse));
});
