import assert from 'node:assert/strict';
import test from 'node:test';

import { compareFrames, dilate, inkMask } from '../src/compare.mjs';
import { pixelVerdict } from '../src/gate.mjs';

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} paint
 */
function frame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { width, height, data };
}

const square = (size) => (x, y) =>
  x >= 10 && x < 10 + size && y >= 10 && y < 10 + size ? [0, 0, 0, 255] : [0, 0, 0, 0];

test('identical frames produce no change at all', () => {
  const a = frame(64, 64, square(30));
  const b = frame(64, 64, square(30));
  const m = compareFrames(a, b, { diff: false });
  assert.equal(m.lostInk, 0);
  assert.equal(m.gainedInk, 0);
  assert.equal(m.changedPixels, 0);
  assert.equal(m.colourP99, 0);
  assert.equal(pixelVerdict(m), 'ok');
});

/** Square with fractional-coverage edges, so a sub-pixel shift is expressible. */
const coverSquare = (left, top, size) => (x, y) => {
  const cov = (start, i) => Math.max(0, Math.min(i + 1, start + size) - Math.max(i, start));
  const a = cov(left, x) * cov(top, y);
  return [0, 0, 0, Math.round(a * 255)];
};

test('a sub-pixel shift stays inside tolerance', () => {
  const a = frame(64, 64, coverSquare(10, 10, 30));
  const b = frame(64, 64, coverSquare(10.4, 10, 30));
  const m = compareFrames(a, b, { diff: false });
  assert.equal(m.lostInk, 0, 'dilation should absorb a sub-pixel edge shift');
  assert.equal(m.gainedInk, 0);
  assert.equal(pixelVerdict(m), 'ok');
});

test('a one pixel shift is inside tolerance, three pixels is not', () => {
  const base = frame(64, 64, coverSquare(10, 10, 30));
  const one = compareFrames(base, frame(64, 64, coverSquare(11, 10, 30)), { diff: false });
  assert.equal(pixelVerdict(one), 'ok', '1px of registration slack is the stated tolerance');
  const three = compareFrames(base, frame(64, 64, coverSquare(13, 10, 30)), { diff: false });
  assert.equal(pixelVerdict(three), 'broken', '3px is a real misalignment');
});

test('a removed shape is reported as lost paint', () => {
  const a = frame(64, 64, square(30));
  const b = frame(64, 64, () => [0, 0, 0, 0]);
  const m = compareFrames(a, b, { diff: false });
  assert.ok(m.lostInk > 700, `expected most of the square to be lost, got ${m.lostInk}`);
  assert.equal(pixelVerdict(m), 'broken');
});

test('opacity change is seen even though the silhouette is identical', () => {
  const opaque = frame(64, 64, (x, y) => (square(30)(x, y)[3] ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const faded = frame(64, 64, (x, y) => (square(30)(x, y)[3] ? [0, 0, 0, 77] : [0, 0, 0, 0]));
  const m = compareFrames(opaque, faded, { diff: false });
  assert.equal(m.lostInk, 0, 'the silhouette did not change');
  assert.ok(m.colourP99 > 100, `flattened-over-white delta should be large, got ${m.colourP99}`);
  assert.equal(pixelVerdict(m), 'broken');
});

test('a small dot vanishing inside a big filled area is caught by the region rule', () => {
  const withDot = (x, y) => {
    const inRect = x >= 4 && x < 252 && y >= 4 && y < 252;
    if (!inRect) return [0, 0, 0, 0];
    const dx = x - 128;
    const dy = y - 128;
    if (dx * dx + dy * dy <= 100) return [0, 0, 0, 255];
    return [0, 200, 0, 255];
  };
  const withoutDot = (x, y) => {
    const inRect = x >= 4 && x < 252 && y >= 4 && y < 252;
    return inRect ? [0, 200, 0, 255] : [0, 0, 0, 0];
  };
  const m = compareFrames(frame(256, 256, withDot), frame(256, 256, withoutDot), { diff: false });
  assert.equal(m.lostInk, 0, 'alpha never changes: the dot sits inside opaque paint');
  assert.ok(
    m.colourChangedRatio < 0.02,
    `global ratio is deliberately blind here, got ${m.colourChangedRatio}`,
  );
  const region = m.worstCells[0];
  assert.ok(region, 'a region should be reported');
  assert.ok(region.ratio > 0.2, `region ratio should dominate, got ${region.ratio}`);
  assert.equal(pixelVerdict(m), 'broken');
});

test('different render sizes are a hard failure, not a ratio', () => {
  const a = frame(64, 64, square(30));
  const b = frame(32, 64, square(30));
  const m = compareFrames(a, b, { diff: false });
  assert.equal(m.sizeMatch, false);
  assert.equal(pixelVerdict(m), 'broken');
});

test('ink mask and dilation are pure functions of alpha', () => {
  const a = frame(5, 5, (x, y) => (x === 2 && y === 2 ? [0, 0, 0, 20] : [0, 0, 0, 0]));
  const mask = inkMask(a);
  assert.equal(mask[2 * 5 + 2], 1);
  const grown = dilate(mask, 5, 5);
  assert.equal(grown[1 * 5 + 2], 1);
  assert.equal(grown[2 * 5 + 1], 1);
  assert.equal(grown[0], 0);
});
