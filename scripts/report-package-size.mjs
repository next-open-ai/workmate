import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [releaseDirectory, maxMbText] = process.argv.slice(2);
const maxBytes = Number(maxMbText) * 1_000_000;
if (!releaseDirectory || !Number.isFinite(maxBytes)) throw new Error('Usage: report-package-size.mjs <release-dir> <max-mb>');

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(fullPath) : [fullPath];
  });
}

const files = existsSync(releaseDirectory) ? filesIn(releaseDirectory) : [];
if (!files.length) throw new Error(`No release files found in ${releaseDirectory}`);
const artifactPattern = /\.(dmg|exe|AppImage|deb|zip)$/i;
const packages = files
  // Ignore unpacked app directories and update metadata: the release budget is
  // for user-downloadable installers only.
  .filter((file) => artifactPattern.test(file))
  .map((file) => ({ file, bytes: statSync(file).size }))
  .sort((left, right) => right.bytes - left.bytes);

if (!packages.length) throw new Error(`No installable artifacts found in ${releaseDirectory}`);
for (const artifact of packages) {
  console.log(`${(artifact.bytes / 1_000_000).toFixed(1)} MB  ${artifact.file}`);
  if (artifact.bytes > maxBytes) throw new Error(`Package exceeds ${maxMbText} MB budget: ${artifact.file}`);
}
