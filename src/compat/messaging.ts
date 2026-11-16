import { isRequest, type Request, type RequestType, type ResponseOf } from '../shared/messages.ts';
import { ext } from './browser.ts';

export type RequestSender = { tabId: number | null; url: string | null };

export const sendRequest = <K extends RequestType>(req: Extract<Request, { type: K }>): Promise<ResponseOf<K>> => ext.runtime.sendMessage(req);

export function onRequest(handler: (req: Request, sender: RequestSender) => Promise<unknown>): void {
  ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRequest(message)) {
      return false;
    }
    handler(message, { tabId: sender.tab?.id ?? null, url: sender.url ?? null }).then(sendResponse, (error: unknown) => {
      console.warn(`PureFeed: ${message.type} failed`, error);
    });
    return true;
  });
}
