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

function directoryBytes(directory) {
  return filesIn(directory).reduce((sum, file) => sum + statSync(file).size, 0);
}

function reportLargestPackagedResources(directory) {
  const resourceRoots = [];
  const visit = (current, depth = 0) => {
    if (depth > 5) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.name.toLowerCase() === 'resources') resourceRoots.push(fullPath);
      else visit(fullPath, depth + 1);
    }
  };
  visit(directory);
  for (const root of resourceRoots) {
    const rows = readdirSync(root, { withFileTypes: true }).map((entry) => {
      const target = path.join(root, entry.name);
      return { target, bytes: entry.isDirectory() ? directoryBytes(target) : statSync(target).size };
    }).sort((left, right) => right.bytes - left.bytes).slice(0, 12);
    console.log(`Largest packaged resources under ${root}:`);
    for (const row of rows) console.log(`  ${(row.bytes / 1_000_000).toFixed(1)} MB  ${row.target}`);
  }
}

const files = existsSync(releaseDirectory) ? filesIn(releaseDirectory) : [];
if (!files.length) throw new Error(`No release files found in ${releaseDirectory}`);
const artifactPattern = /\.(dmg|exe|AppImage|deb|zip)$/i;
const packages = files
  // Ignore unpacked app directories and update metadata: the release budget is
  // for user-downloadable installers only. Dependency archives can exist under
  // an unpacked app and must not be mistaken for release artifacts.
  .filter((file) => path.resolve(path.dirname(file)) === path.resolve(releaseDirectory) && artifactPattern.test(file))
  .map((file) => ({ file, bytes: statSync(file).size }))
  .sort((left, right) => right.bytes - left.bytes);

if (!packages.length) throw new Error(`No installable artifacts found in ${releaseDirectory}`);
reportLargestPackagedResources(releaseDirectory);
for (const artifact of packages) {
  console.log(`${(artifact.bytes / 1_000_000).toFixed(1)} MB  ${artifact.file}`);
  if (artifact.bytes > maxBytes) throw new Error(`Package exceeds ${maxMbText} MB budget: ${artifact.file}`);
}
