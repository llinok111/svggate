#!/usr/bin/env node
/**
 * Test runner.
 *
 * `node --test test/` behaves differently across platforms and Node majors, and
 * the quoted-glob form only exists from Node 22. Declared support starts at
 * Node 18, so the runner expands the directory itself and spawns one process per
 * file: the same list, the same order, on every platform.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  process.stderr.write('no test files found\n');
  process.exit(1);
}

let failed = 0;
let passed = 0;
const started = Date.now();
for (const file of files) {
  const result = spawnSync(process.execPath, [join(testDir, file)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const ok = result.status === 0;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tests = countTests(output);
  if (ok) {
    passed += tests.pass;
    process.stdout.write(`ok   ${file}  (${tests.pass} tests)\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${file}\n`);
    process.stdout.write(indent(output));
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(`\n${passed} tests passed, ${failed} file(s) failed in ${seconds}s\n`);
process.exit(failed === 0 ? 0 : 1);

function countTests(output) {
  const pass = (output.match(/^ok \d+/gm) ?? []).length;
  return { pass };
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}
