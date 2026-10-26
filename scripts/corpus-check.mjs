#!/usr/bin/env node
/**
 * The false-positive gate.
 *
 * svggate catches regressions; this script guards it against the failure mode
 * that would make it useless: firing on healthy files. It replays the default
 * preset over every SVG in test/corpus and fails if any of them is reported
 * `broken`.
 *
 * `review` is allowed and listed, because a warning that names its reason
 * (rewritten CSS, dropped percentage dimensions) is information, not noise.
 * `broken` means the gate claims a real asset is damaged; if that happens the
 * thresholds are wrong and CI should say so before a user does.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gate } from '../src/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'test', 'corpus');
const list = readFileSync(join(root, 'scripts', 'corpus-list.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

/** @type {Map<string, {verdict: string, plugins: string[], reasons: string[]}>} */
const summary = new Map();
const broken = [];
for (const name of list) {
  const report = gate(readFileSync(join(corpusDir, name), 'utf8'), { strategy: 'report' });
  summary.set(name, {
    verdict: report.verdict,
    plugins: report.blamed.map((b) => b.plugin),
    reasons: report.blamed.flatMap((b) => b.reasons),
  });
  if (report.verdict === 'broken') {
    broken.push({ name, plugins: report.blamed.map((b) => b.plugin), reasons: report.blamed.flatMap((b) => b.reasons) });
  }
}

const counts = {};
for (const entry of summary.values()) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
process.stdout.write(`${list.length} corpus files: ${JSON.stringify(counts)}\n`);
const pluginTally = new Map();
for (const entry of summary.values()) {
  for (const plugin of entry.plugins) pluginTally.set(plugin, (pluginTally.get(plugin) ?? 0) + 1);
}
for (const [plugin, count] of [...pluginTally].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  reviewed by ${plugin}: ${count}\n`);
}

if (broken.length > 0) {
  process.stderr.write(`\n${broken.length} false failure(s):\n`);
  for (const entry of broken) {
    process.stderr.write(`  ${entry.name} — ${entry.plugins.join(', ')}\n`);
    for (const reason of entry.reasons) process.stderr.write(`      ${reason}\n`);
  }
  process.exit(1);
}

process.stdout.write('no false failures\n');
