import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const directory = new URL('../.github/workflows/', import.meta.url);
const read = (name) => readFileSync(new URL(name, directory), 'utf8');
// Check the deliberately small matrix shape without adding a YAML dependency.
const activeLines = (source) => source.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

test('REL-RUNNER AT1: workflow runners and basic Actions are supported', () => {
  for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const source = activeLines(read(name));
    assert.doesNotMatch(source, /(?:os:|runs-on:)\s*macos-(?:13|14)\b/, name);
    for (const [action, version] of [['checkout', 'v5'], ['setup-node', 'v5'], ['setup-python', 'v6']]) {
      const references = [...source.matchAll(new RegExp(`uses: actions/${action}@([^\\s]+)`, 'g'))];
      for (const reference of references) assert.equal(reference[1], version, `${name}: ${action}`);
    }
  }
});

test('REL-RUNNER AT1: CI and Release preserve native targets and package budgets', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const source = activeLines(read(name));
    const entries = source.split(/(?=^\s*- os:)/m).slice(1).map((entry) => entry.split(/^    runs-on:/m)[0]);
    assert.equal(entries.length, 2, name);
    assert.match(entries[0], /- os: macos-15\s/);
    assert.match(entries[0], /artifact: macos-arm64\s/);
    assert.match(entries[0], /expected_extension: dmg\s/);
    assert.match(entries[1], /- os: windows-latest\s/);
    assert.match(entries[1], /artifact: windows-x64\s/);
    assert.match(entries[1], /expected_extension: exe\s/);
    for (const entry of entries) assert.match(entry, /max_package_mb: 220\s/);
    assert.match(source, /node-version: 22/);
    assert.match(source, /python-version: '3\.11'/);
    assert.match(source, /node scripts\/report-package-size\.mjs apps\/desktop\/release \$\{\{ matrix.max_package_mb \}\}/);
    assert.match(source, /fail-fast: false/);
  }
  const release = read('release.yml');
  assert.match(release, /arch: arm64/);
  assert.match(release, /arch: x64/);
  assert.match(release, /tags: \['v\*'\]/);
  assert.match(release, /test "\$\(find publish-assets -type f \| wc -l\)" -eq 2/);
  assert.match(release, /needs: package/);
});
