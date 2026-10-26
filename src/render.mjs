/**
 * Deterministic rasterisation.
 *
 * resvg (Rust, via @resvg/resvg-js) instead of a headless browser on purpose:
 * the question is "same input, different optimiser output — different pixels?",
 * so the renderer must be a constant, not a variable. A browser adds a font
 * stack, a compositor and a cache; resvg adds none of them.
 *
 * Scaling is by *user unit*, not by the width attribute. Rendering at
 * `width: 512` was the first implementation and it hid the very bug that
 * motivated this tool: svgo#2104's 2-unit dot lives in a 52x185 viewBox inside a
 * 590x310 canvas, so `preserveAspectRatio="meet"` shrank it to 3px and every
 * metric read zero. Mapping the viewBox to a fixed pixel budget instead keeps a
 * 2-unit feature ~17px wide regardless of the artboard.
 *
 * Known limit, stated here so it cannot leak into a claim: system fonts are
 * loaded by default, so glyph rasterisation depends on the machine. Both frames
 * of a comparison come from the same machine, so a difference is still a
 * difference — cross-machine byte equality is not promised for text.
 */

import { Resvg } from '@resvg/resvg-js';

const MAX_EDGE = 1536;
const MIN_EDGE = 24;

/**
 * @param {string} svg
 * @param {{width?: number, height?: number, systemFonts?: boolean}} [options]
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function render(svg, options = {}) {
  const { width, height, systemFonts = true } = options;
  const config = { font: { loadSystemFonts: systemFonts } };
  if (typeof width === 'number' && typeof height === 'number') {
    config.fitTo = { mode: 'width', value: width };
  } else if (typeof width === 'number') {
    config.fitTo = { mode: 'width', value: width };
  }
  const resvg = new Resvg(svg, config);
  const image = resvg.render();
  const pixels = image.pixels;
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
  };
}

/**
 * Plans a comparable pixel size from a document's own geometry.
 * Both sides of every comparison are rendered at this size, so a change in the
 * coordinate system shows up as a size mismatch instead of being normalised away.
 * @param {import('./structural.mjs').Snapshot} snapshot
 * @returns {{width: number, height: number, density: number}}
 */
export function planSize(snapshot) {
  const viewBox = snapshot.root.viewBox;
  const nums = viewBox
    ? viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n))
    : [];
  let w;
  let h;
  if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) {
    w = nums[2];
    h = nums[3];
  } else {
    w = Number.parseFloat(snapshot.root.width ?? '0') || 0;
    h = Number.parseFloat(snapshot.root.height ?? '0') || 0;
    if (!(w > 0 && h > 0)) return { width: 512, height: 512, density: 1 };
  }
  const maxEdge = Math.max(w, h);
  const density = MAX_EDGE / maxEdge;
  const width = Math.max(MIN_EDGE, Math.round(w * density));
  const height = Math.max(MIN_EDGE, Math.round(h * density));
  return { width, height, density };
}

/**
 * Rewrite the root width/height so the renderer maps one user unit to `density`
 * pixels. Only the root tag is touched; nothing inside the document moves.
 * @param {string} svg
 * @param {{width: number, height: number}} size
 * @returns {string}
 */
export function withSize(svg, size) {
  const start = svg.indexOf('<svg');
  if (start === -1) throw new Error('svggate: no <svg> root found');
  const end = svg.indexOf('>', start);
  if (end === -1) throw new Error('svggate: unterminated <svg> tag');
  const head = svg
    .slice(0, end)
    .replace(/\s(?:width|height)\s*=\s*"[^"]*"/g, '')
    .replace(/\s(?:width|height)\s*=\s*'[^']*'/g, '');
  return `${head} width="${size.width}" height="${size.height}"${svg.slice(end)}`;
}

/**
 * Render a document at a pre-planned comparable size.
 * @param {string} svg
 * @param {{width: number, height: number}} size
 * @param {{systemFonts?: boolean}} [options]
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function renderSized(svg, size, options = {}) {
  return render(withSize(svg, size), { width: size.width, systemFonts: options.systemFonts });
}

/**
 * Render at intrinsic size — used only for the layout-level check (did the
 * drawing's own size change), never for pixel comparison.
 * @param {string} svg
 * @param {{systemFonts?: boolean}} [options]
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function renderIntrinsic(svg, options = {}) {
  return render(svg, { systemFonts: options.systemFonts });
}
