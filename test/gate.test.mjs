import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { gate, PRESET_DEFAULT, runAll } from '../src/index.mjs';
import { toJson } from '../src/report.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('the preset mirror matches a real svgo preset-default run', () => {
  const names = ['use-inheritance.svg', 'arc-dot.svg', 'clean-icon.svg', 'current-color.svg', 'animated.svg'];
  for (const name of names) {
    const svg = fixture(name);
    const stepped = runAll(svg, PRESET_DEFAULT, false);
    const upstream = runAll(svg, ['preset-default'], false);
    assert.equal(stepped, upstream, `${name}: plugin list drifted from preset-default`);
  }
  assert.equal(PRESET_DEFAULT.length, 34);
  assert.equal(PRESET_DEFAULT[0], 'removeDoctype');
  assert.equal(PRESET_DEFAULT[PRESET_DEFAULT.length - 1], 'removeDesc');
});

test('upstream #2239 is detected and attributed to removeUnknownsAndDefaults', () => {
  const report = gate(fixture('use-inheritance.svg'), { strategy: 'report' });
  assert.equal(report.verdict, 'broken');
  const blamed = report.blamed.map((b) => b.plugin);
  assert.ok(blamed.includes('removeUnknownsAndDefaults'), blamed.join(','));
  const reasons = report.blamed.find((b) => b.plugin === 'removeUnknownsAndDefaults').reasons;
  assert.ok(
    reasons.some((reason) => reason.includes('paint drifted')),
    `expected a paint-drift reason, got: ${reasons.join(' | ')}`,
  );
});

test('upstream #2104 is detected and attributed to convertPathData', () => {
  const report = gate(fixture('arc-dot.svg'), { strategy: 'report' });
  assert.equal(report.verdict, 'broken');
  const blamed = report.blamed.map((b) => b.plugin);
  assert.ok(blamed.includes('convertPathData'), blamed.join(','));
  const reasons = report.blamed.find((b) => b.plugin === 'convertPathData').reasons;
  assert.ok(
    reasons.some((reason) => reason.includes('localised change')),
    `expected a localised-change reason, got: ${reasons.join(' | ')}`,
  );
});

test('a healthy icon produces no pixel findings', () => {
  const report = gate(fixture('clean-icon.svg'), { strategy: 'report' });
  assert.equal(report.verdict, 'ok');
  assert.deepEqual(report.blamed, []);
  const pixelFindings = report.steps.flatMap((step) =>
    step.delta.filter((d) => d.verdict !== 'ok'),
  );
  assert.deepEqual(pixelFindings, [], 'no step should move pixels on a clean icon');
});

test('animated and currentColor documents survive the default preset', () => {
  for (const name of ['animated.svg', 'current-color.svg']) {
    const report = gate(fixture(name), { strategy: 'report' });
    assert.equal(report.verdict, 'ok', `${name} should be untouched by preset-default`);
  }
});

test('strategy drop keeps the artifact safe and reports what it removed', () => {
  const report = gate(fixture('use-inheritance.svg'), { strategy: 'drop' });
  assert.ok(report.dropped.includes('removeUnknownsAndDefaults'));
  assert.ok(report.artifact, 'an artifact should be produced');
  assert.equal(report.artifact.verdict, 'ok', 'the surviving artifact must be safe');
  assert.ok(report.artifact.svg.length > 0);
  assert.ok(!report.artifact.svg.includes('fill-opacity="1"') === false);
});

test('strategy none reports without producing an artifact', () => {
  const report = gate(fixture('clean-icon.svg'), { strategy: 'none' });
  assert.equal(report.artifact, null);
});

test('the gate is deterministic: same input, same report', () => {
  const svg = fixture('arc-dot.svg');
  const strip = (report) =>
    JSON.stringify(toJson(report), (key, value) => (key === 'ms' ? 0 : value));
  assert.equal(strip(gate(svg, { strategy: 'report' })), strip(gate(svg, { strategy: 'report' })));
});

test('a dangling aria reference is caught by structure, not pixels', () => {
  const report = gate(fixture('aria-labelledby.svg'), { strategy: 'report' });
  assert.equal(report.verdict, 'broken');
  assert.deepEqual(
    report.blamed.map((b) => b.plugin),
    ['cleanupIds'],
  );
  assert.equal(report.artifact.pixels, 'ok', 'the picture is identical — that is the point');
  assert.ok(
    report.artifact.findings.some((finding) => finding.code === 'dangling-reference'),
    'the artifact must carry a dangling-reference finding',
  );
});

test('a broken plugin is attributed once, not by every later plugin', () => {
  const report = gate(fixture('use-inheritance.svg'), { strategy: 'none' });
  const blamed = report.blamed.map((b) => b.plugin);
  assert.equal(blamed.length, 1, `expected one culprit, got ${blamed.join(',')}`);
  const after = report.steps.filter((step) =>
    report.steps.indexOf(step) > report.steps.findIndex((s) => s.plugin === blamed[0]),
  );
  assert.ok(after.length > 5, 'the fixture should have plugins after the culprit');
  for (const step of after) {
    assert.notEqual(step.blame, 'broken', `${step.plugin} should not be blamed for a carried-over state`);
  }
});
