import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startWebLauncher } from './lib/web-launcher.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await startWebLauncher(projectRoot);
