import { createInProcessHost } from '../decoder/in-process-host.ts';
import { startBackground } from './background.ts';

startBackground(createInProcessHost(document));
