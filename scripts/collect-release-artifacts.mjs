import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const [sourceDirectory, destinationDirectory, extension] = process.argv.slice(2);
if (!sourceDirectory || !destinationDirectory || !extension) {
  throw new Error('Usage: collect-release-artifacts.mjs <source-dir> <destination-dir> <extension>');
}
if (!existsSync(sourceDirectory)) throw new Error(`Release directory does not exist: ${sourceDirectory}`);

const suffix = `.${extension.toLowerCase()}`;
const artifacts = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
  .map((entry) => entry.name);

if (!artifacts.length) throw new Error(`No .${extension} installer found in ${sourceDirectory}`);
rmSync(destinationDirectory, { recursive: true, force: true });
mkdirSync(destinationDirectory, { recursive: true });
for (const artifact of artifacts) cpSync(path.join(sourceDirectory, artifact), path.join(destinationDirectory, artifact));
console.log(`Collected ${artifacts.length} release installer(s): ${artifacts.join(', ')}`);
