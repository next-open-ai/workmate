import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const limits = [
  { file: 'apps/renderer/dist/assets', maxBytes: 1_500_000, label: 'renderer assets' },
];

function sizeOf(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (stat.isFile()) return stat.size;
  return readdirSync(target, { withFileTypes: true })
    .reduce((total, entry) => total + sizeOf(path.join(target, entry.name)), 0);
}

let failed = false;
for (const limit of limits) {
  const bytes = await sizeOf(limit.file);
  const mb = (bytes / 1_000_000).toFixed(2);
  console.log(`${limit.label}: ${mb} MB / ${(limit.maxBytes / 1_000_000).toFixed(2)} MB`);
  if (bytes > limit.maxBytes) failed = true;
}
if (failed) process.exitCode = 1;
