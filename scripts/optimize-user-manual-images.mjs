import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(repoRoot, 'docs/guides/images');
const sources = (await readdir(imageDir)).filter((name) => /^user-manual-.*\.png$/i.test(name)).sort();
if (!sources.length) throw new Error('No user-manual PNG images found.');

const probe = spawnSync('cwebp', ['-version'], { encoding: 'utf8' });
if (probe.error?.code === 'ENOENT') {
  throw new Error('cwebp is required to refresh manual WebP assets. Install the WebP tools package first.');
}
if (probe.status !== 0) throw new Error(probe.stderr || 'Unable to run cwebp.');

for (const sourceName of sources) {
  const input = path.join(imageDir, sourceName);
  const output = path.join(imageDir, sourceName.replace(/\.png$/i, '.webp'));
  const result = spawnSync('cwebp', ['-quiet', '-q', '82', '-m', '6', '-metadata', 'none', input, '-o', output], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Failed to optimize ${sourceName}: ${result.stderr || result.stdout}`);
  console.log(`optimized ${path.relative(repoRoot, input)} -> ${path.relative(repoRoot, output)}`);
}
