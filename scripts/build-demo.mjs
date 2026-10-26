#!/usr/bin/env node
/**
 * Builds the GitHub Pages demo from real gate runs.
 *
 * Nothing on the page is hand-written: every verdict, number and diff image
 * comes out of `gate()` on a fixture in `test/fixtures/`. If the tool changes
 * behaviour, the page changes with it — a demo that can drift from the tool is
 * worse than no demo.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { gate } from '../src/index.mjs';
import { toMarkdown } from '../src/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'docs', 'data');
mkdirSync(dataDir, { recursive: true });

const SAMPLES = [
  { file: 'use-inheritance.svg', note: 'upstream svgo#2239 — fill-opacity="1" is the only thing blocking inheritance into <use>' },
  { file: 'arc-dot.svg', note: 'upstream svgo#2104 — a 2-unit dot disappears when the path is rewritten as a degenerate arc' },
  { file: 'aria-labelledby.svg', note: 'upstream svgo#2300 — cleanupIds strips the <title> id and leaves aria-labelledby dangling; pixels are identical' },
  { file: 'clean-icon.svg', note: 'a healthy icon: the preset changes nothing measurable' },
  { file: 'current-color.svg', note: 'currentColor and stroke geometry survive' },
  { file: 'animated.svg', note: 'a SMIL animation element is preserved' },
  { file: 'text-label.svg', note: 'text-bearing label (fonts off by default, so glyphs are not compared)' },
];

const reports = [];
for (const sample of SAMPLES) {
  const path = join(root, 'test', 'fixtures', sample.file);
  const svg = readFileSync(path, 'utf8');
  const key = basename(sample.file, '.svg');
  const diffs = [];
  const report = gate(svg, {
    strategy: 'report',
    onDiff: (plugin, width, metrics) => {
      if (!metrics.diff) return;
      const name = `${key}.${plugin}.diff.png`;
      const png = new PNG({ width: metrics.diff.width, height: metrics.diff.height });
      png.data = Buffer.from(metrics.diff.data);
      writeFileSync(join(dataDir, name), PNG.sync.write(png));
      if (!diffs.includes(name)) diffs.push(name);
    },
  });
  writeFileSync(join(dataDir, `${key}.input.svg`), svg);
  if (report.artifact) {
    writeFileSync(join(dataDir, `${key}.artifact.svg`), report.artifact.svg);
  }
  for (const step of report.steps) {
    const strong = step.delta.filter((point) => point.verdict !== 'ok');
    if (strong.length > 0) step.diffNames = diffs.filter((name) => name.includes(`.${step.plugin}.`));
  }
  reports.push({
    key,
    note: sample.note,
    verdict: report.verdict,
    sizes: report.sizes,
    input: report.input,
    blamed: report.blamed,
    dropped: report.dropped,
    artifact: report.artifact
      ? {
          verdict: report.artifact.verdict,
          pixels: report.artifact.pixels,
          findings: report.artifact.findings,
          bytes: report.artifact.svg.length,
        }
      : null,
    steps: report.steps.map((step) => ({
      index: step.index,
      plugin: step.plugin,
      bytes: step.bytes,
      bytesSaved: step.bytesSaved,
      ms: step.ms,
      verdict: step.verdict,
      stateVerdict: step.stateVerdict,
      findings: step.findings.filter((finding) => finding.severity !== 'info'),
      info: step.findings.filter((finding) => finding.severity === 'info').map((f) => f.message),
      worst: step.delta
        .slice()
        .sort((a, b) => b.metrics.changedRatio - a.metrics.changedRatio)
        .map((point) => ({
          width: point.width,
          verdict: point.verdict,
          lostInk: point.metrics.lostInk,
          gainedInk: point.metrics.gainedInk,
          colourP99: point.metrics.colourP99,
          colourChangedRatio: Number(point.metrics.colourChangedRatio.toFixed(4)),
          changedRatio: Number(point.metrics.changedRatio.toFixed(5)),
          worstCell: point.metrics.worstCells[0]
            ? {
                ratio: Number(point.metrics.worstCells[0].ratio.toFixed(3)),
                changed: point.metrics.worstCells[0].changed,
                x: point.metrics.worstCells[0].x,
                y: point.metrics.worstCells[0].y,
              }
            : null,
        }))[0],
    })),
    diffs,
    markdown: toMarkdown(report, { name: sample.file }),
  });
  process.stdout.write(`${sample.file}: ${report.verdict}\n`);
}

// The false-positive measurement, recomputed from the shipped corpus.
const corpusDir = join(root, 'test', 'corpus');
const corpus = [];
for (const name of readFileSync(join(root, 'scripts', 'corpus-list.txt'), 'utf8').split('\n')) {
  const entry = name.trim();
  if (!entry) continue;
  const report = gate(readFileSync(join(corpusDir, entry), 'utf8'), { strategy: 'report' });
  corpus.push({
    name: entry,
    verdict: report.verdict,
    blamed: report.blamed.map((b) => ({ plugin: b.plugin, reason: b.reasons[0] ?? '' })),
  });
}
const corpusSummary = corpus.reduce((acc, entry) => {
  acc[entry.verdict] = (acc[entry.verdict] ?? 0) + 1;
  return acc;
}, {});

writeFileSync(
  join(dataDir, 'report.json'),
  `${JSON.stringify({ generated: new Date().toISOString(), reports, corpus, corpusSummary }, null, 2)}\n`,
);

const template = readFileSync(join(root, 'scripts', 'demo.html'), 'utf8');
writeFileSync(join(root, 'docs', 'index.html'), template.replace('/*DATA*/', JSON.stringify({ reports, corpus, corpusSummary })));
process.stdout.write(`corpus: ${JSON.stringify(corpusSummary)}\n`);
process.stdout.write('docs/index.html written\n');
