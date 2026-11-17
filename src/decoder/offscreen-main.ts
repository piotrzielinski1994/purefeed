import { ext } from '../compat/browser.ts';
import { createInProcessHost } from './in-process-host.ts';
import { handleOffscreenMessage, isOffscreenMessage } from './offscreen-protocol.ts';

const host = createInProcessHost(document);

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) {
    return false;
  }
  handleOffscreenMessage(host, message).then(sendResponse);
  return true;
});
