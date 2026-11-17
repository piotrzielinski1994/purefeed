import { createOffscreenHost } from '../decoder/offscreen-host.ts';
import { startBackground } from './background.ts';

startBackground(createOffscreenHost());
