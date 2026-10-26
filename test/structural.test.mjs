import assert from 'node:assert/strict';
import test from 'node:test';

import { diffSnapshots, snapshot, viewBoxDelta } from '../src/structural.mjs';

const svg = (body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"${extra}>${body}</svg>`;

/** @param {string} before @param {string} after */
const findings = (before, after) => diffSnapshots(snapshot(before), snapshot(after));

const codes = (list) => list.map((f) => f.code);

test('a reference left pointing at a removed id is an error', () => {
  const before = svg('<title id="t">label</title><rect width="10" height="10" aria-labelledby="t"/>');
  const after = svg('<title>label</title><rect width="10" height="10" aria-labelledby="t"/>');
  const found = findings(before, after);
  assert.ok(codes(found).includes('dangling-reference'));
  assert.equal(found.find((f) => f.code === 'dangling-reference').severity, 'error');
});

test('renaming an id together with its references is only informational', () => {
  const before = svg('<defs><linearGradient id="sky"/></defs><rect width="10" height="10" fill="url(#sky)"/>');
  const after = svg('<defs><linearGradient id="a"/></defs><rect width="10" height="10" fill="url(#a)"/>');
  const found = findings(before, after);
  assert.deepEqual(codes(found), ['ids-renamed']);
  assert.equal(found[0].severity, 'info');
});

test('a stylesheet selector that no longer resolves is an error', () => {
  const before = svg('<style>#mark{fill:red}</style><rect id="mark" width="10" height="10"/>');
  const after = svg('<style>.mark{fill:red}</style><rect width="10" height="10"/>');
  const found = findings(before, after);
  const lost = found.find((f) => f.code === 'style-selector-lost');
  assert.equal(lost.severity, 'error');
});

test('a hex colour in a style attribute is not an id reference', () => {
  const before = svg('<rect width="10" height="10" style="fill:none;stroke:#005ac3"/>');
  const after = svg('<rect width="10" height="10" style="fill:none;stroke:#0af"/>');
  assert.deepEqual(codes(findings(before, after)), []);
});

test('viewBox rounding is informational, real movement is an error', () => {
  const before = svg('<rect width="10" height="10"/>', ' viewBox="2195.656274 1486.713736 52.67746 185.305106"');
  const rounded = svg('<rect width="10" height="10"/>', ' viewBox="2195.656 1486.714 52.677 185.305"');
  const moved = svg('<rect width="10" height="10"/>', ' viewBox="2200.656 1486.714 52.677 185.305"');
  assert.equal(findings(before, rounded)[0].code, 'viewBox-rounded');
  assert.equal(findings(before, rounded)[0].severity, 'info');
  assert.equal(findings(before, moved)[0].code, 'viewBox-changed');
  assert.equal(findings(before, moved)[0].severity, 'error');
});

test('viewBoxDelta is relative to the box, not to its offset', () => {
  assert.equal(viewBoxDelta('0 0 100 100', '0 0 100 100'), 0);
  assert.ok(Math.abs(viewBoxDelta('0 0 100 100', '0 0 100 101') - 0.01) < 1e-9);
  assert.equal(viewBoxDelta('0 0 100 100', 'nonsense'), null);
});

test('removing the viewBox, script, animation, text or image is an error', () => {
  assert.equal(
    findings(svg('<rect width="10"/>'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="10"/></svg>')[0]
      .code,
    'viewBox-removed',
  );
  assert.ok(
    codes(
      findings(
        svg('<script>go()</script><rect width="10" height="10"/>'),
        svg('<rect width="10" height="10"/>'),
      ),
    ).includes('script-removed'),
  );
  assert.ok(
    codes(
      findings(
        svg('<rect width="10" height="10"><animate attributeName="x" dur="1s"/></rect>'),
        svg('<rect width="10" height="10"/>'),
      ),
    ).includes('animation-removed'),
  );
  assert.ok(
    codes(
      findings(svg('<text x="1" y="1">hi</text>'), svg('<rect width="1" height="1"/>')),
    ).includes('text-element-removed'),
  );
});

test('dropping width and height is a warning, not an error', () => {
  const before = svg('<rect width="10" height="10"/>');
  const after = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="10" height="10"/></svg>';
  const found = findings(before, after);
  assert.equal(found.find((f) => f.code === 'intrinsic-size-removed').severity, 'warn');
});

test('text content changes are reported separately from element removal', () => {
  const found = findings(svg('<text>before</text>'), svg('<text>after</text>'));
  assert.ok(codes(found).includes('text-content-changed'));
  assert.equal(found.find((f) => f.code === 'text-content-changed').severity, 'warn');
});

test('an untouched document produces no findings at all', () => {
  const doc = svg('<defs><mask id="m"/></defs><rect width="10" height="10" mask="url(#m)"/>');
  assert.deepEqual(findings(doc, doc), []);
});
