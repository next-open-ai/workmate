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

test('REL-RUNNER AT2: Node setup does not require pnpm before Corepack activation', () => {
  let checked = 0;
  for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const source = activeLines(read(name));
    const steps = source.split(/(?=^      - )/m);
    for (let index = 0; index < steps.length; index += 1) {
      if (!steps[index].includes('uses: actions/setup-node@')) continue;
      checked += 1;
      assert.match(steps[index], /package-manager-cache: false\s/, name);
      assert.doesNotMatch(steps[index], /^\s+cache:\s*pnpm\b/m, name);
      const following = steps.slice(index + 1).join('');
      const enable = following.indexOf('run: corepack enable');
      const verify = following.indexOf('run: pnpm --version');
      const install = following.indexOf('run: pnpm install --frozen-lockfile');
      assert.ok(enable >= 0 && verify > enable && install > verify, `${name}: Corepack must precede pnpm`);
    }
  }
  assert.equal(checked, 5, 'cover CI, Release, npm publish and concurrency workflow');
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
