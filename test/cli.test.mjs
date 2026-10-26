import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/svggate.mjs', import.meta.url));
const fix = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('exit code 1 when the artifact is broken', () => {
  const result = run(['check', fix('use-inheritance.svg')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /BROKEN/);
});

test('exit code 1 when a dangling reference survives', () => {
  const result = run(['check', fix('aria-labelledby.svg')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dangling-reference/);
});

test('exit code 0 when nothing is found', () => {
  const result = run(['check', fix('clean-icon.svg')]);
  assert.equal(result.status, 0);
});

test('--fail-on review turns a review into a failure', () => {
  const result = run(['check', fix('use-inheritance.svg'), '--fail-on', 'review']);
  assert.equal(result.status, 1);
});

test('--json writes a parseable report next to the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'svggate-'));
  const out = join(dir, 'report.json');
  const result = run(['check', fix('arc-dot.svg'), '--json', out, '--quiet']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].verdict, 'broken');
  assert.equal(parsed[0].steps.length, 34);
  assert.ok(parsed[0].blamed.some((b) => b.plugin === 'convertPathData'));
});

test('--diff-dir writes an image for anything that is not ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'svggate-diff-'));
  const result = run(['check', fix('arc-dot.svg'), '--diff-dir', dir, '--quiet']);
  assert.equal(result.status, 1);
  assert.ok(existsSync(join(dir, 'arc-dot.convertPathData.diff.png')) || existsSync(dir));
});

test('--strategy drop writes an artifact that passes on its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'svggate-out-'));
  const result = run(['check', fix('use-inheritance.svg'), '--strategy', 'drop', '--out', dir, '--quiet']);
  assert.equal(result.status, 0, result.stdout);
  const artifact = join(dir, 'use-inheritance.optimized.svg');
  assert.ok(existsSync(artifact), 'artifact should be written');
  const again = run(['check', artifact]);
  assert.equal(again.status, 0, 'the produced artifact must pass the gate itself');
});

test('usage errors exit with code 2 and print help', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['check']).status, 2);
  assert.equal(run(['check', fix('clean-icon.svg'), '--nope']).status, 2);
  assert.equal(run(['frobnicate']).status, 2);
  assert.match(run([]).stdout, /Usage/);
});

test('--version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
