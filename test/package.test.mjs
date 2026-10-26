import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Read every source file so the guards below cover all of them. */
function sources(dir = join(root, 'src'), out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

test('the declared minimum Node version is 18 and nothing needs newer', () => {
  assert.equal(pkg.engines.node, '>=18');
  const guards = [
    ['import.meta.dirname', /import\.meta\.dirname/],
    ['fs.promises.glob', /promises\.glob/],
    ['node:test quoted glob', /--test\s+["']/],
  ];
  for (const file of sources()) {
    for (const [label, pattern] of guards) {
      assert.ok(
        !pattern.test(file.text),
        `${file.path} uses ${label}, which does not exist on every supported Node version`,
      );
    }
  }
});

test('the CLI entry point is executable by Node and uses LF endings', () => {
  const shebang = readFileSync(join(root, 'bin', 'svggate.mjs'));
  assert.ok(shebang.subarray(0, 10).toString().startsWith('#!/usr/bin/env node'));
  assert.ok(!shebang.includes(13), 'CR found: the shebang would break on Linux');
});

test('every shipped file is listed in package.json files', () => {
  for (const entry of pkg.files) {
    assert.ok(statSync(join(root, entry)), `${entry} is listed but missing`);
  }
  assert.deepEqual(Object.keys(pkg.bin), ['svggate']);
});

test('the runtime dependency set stays small and known', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@resvg/resvg-js',
    'pngjs',
    'svgo',
  ]);
});

test('license and attribution files are present and complete', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(notice, /svgo/);
  assert.match(notice, /resvg/);
  assert.match(notice, /MIT/);
});
