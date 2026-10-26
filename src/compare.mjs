/**
 * Pixel comparison tuned for "did this optimization change what people see?"
 *
 * The first version of this file filtered colour comparisons to pixels that were
 * fully opaque in both frames. That filter silently deleted the most common
 * regression of all — a dropped `fill-opacity` (upstream svgo#2239 renders 24%
 * of the frame differently and scored zero). The fix is to stop comparing raw
 * RGBA and compare *what a viewer sees*: each pixel flattened over white, then
 * averaged in 4x4 blocks so antialiasing cannot vote.
 *
 * Four signals, each blind to a different failure:
 *
 *   1. lost / gained ink (full resolution, 1px dilation tolerance)
 *      an element disappeared or appeared. Dilation absorbs sub-pixel edge
 *      shifts; a missing 2-unit dot at 512px wide is still ~240px of paint.
 *   2. colour drift (4x4 blocks, flattened over white)
 *      silhouette kept, paint changed — opacity, fill, stroke, filter.
 *   3. block presence (4x4 blocks, 1 block dilation)
 *      large-area loss, robust to a one-pixel registration difference.
 *   4. strong-change regions (32x32 grid)
 *      the reason this file exists: a 2-unit dot that vanishes inside a large
 *      green rectangle is 0.2% of the ink and 0% of p99, so every global ratio
 *      misses it. Region maxima do not. "Strong" means a channel delta above 48,
 *      well outside what a sub-pixel edge shift produces.
 */

const INK_ALPHA = 16;
const BLOCK = 4;
const PERCEPTIBLE = 8;
const STRONG = 48;
const REGION_GRID = 32;

/**
 * @typedef {{width: number, height: number, data: Uint8ClampedArray | Buffer}} Frame
 * @typedef {{x: number, y: number, ratio: number, changed: number, total: number}} Cell
 * @typedef {{
 *   sizeMatch: boolean,
 *   widthA: number, heightA: number, widthB: number, heightB: number,
 *   inkA: number, inkB: number,
 *   lostInk: number, gainedInk: number, lostRatio: number, gainedRatio: number,
 *   lostBlocks: number, gainedBlocks: number,
 *   colourP99: number, colourMax: number, colourChangedRatio: number,
 *   changedPixels: number, changedRatio: number,
 *   worstCells: Cell[],
 *   diff: Frame | null
 * }} Comparison
 */

/**
 * Binarise painted area from the alpha channel.
 * Alpha rather than a corner colour: frames are rendered on transparency, so
 * alpha *is* coverage, and a white-on-white drawing still counts as ink.
 * @param {Frame} frame
 * @returns {Uint8Array}
 */
export function inkMask(frame) {
  const { width, height, data } = frame;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 3; i < mask.length; i += 1, p += 4) {
    mask[i] = data[p] >= INK_ALPHA ? 1 : 0;
  }
  return mask;
}

/**
 * 3x3 binary dilation (two separable passes) — the anti-aliasing allowance.
 * A pixel only counts as "lost" if the other frame has no ink next to it.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function dilate(mask, width, height) {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      if (mask[i]) {
        tmp[i] = 1;
        if (x > 0) tmp[i - 1] = 1;
        if (x + 1 < width) tmp[i + 1] = 1;
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      if (tmp[i]) {
        out[i] = 1;
        if (y > 0) out[i - width] = 1;
        if (y + 1 < height) out[i + width] = 1;
      }
    }
  }
  return out;
}

/**
 * Flatten RGBA over white and average into BLOCK x BLOCK cells.
 * Compositing first means an opacity change becomes a brightness change, which
 * is exactly how a viewer experiences it.
 * @param {Frame} frame
 * @returns {{width: number, height: number, rgb: Uint8Array, alpha: Float32Array}}
 */
/**
 * A block is "flat" when its 3x3 neighbourhood shows no strong gradient in
 * either colour or alpha. Only flat blocks contribute to colour statistics.
 * @param {{width: number, height: number, rgb: Uint8Array, alpha: Float32Array}} grid
 * @param {number} width
 * @param {number} height
 * @param {number} [limit]
 * @returns {Uint8Array}
 */
export function flatness(grid, width, height, limit = 12) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let contrast = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        contrast = Math.max(
          contrast,
          Math.abs(grid.rgb[i * 3] - grid.rgb[j * 3]),
          Math.abs(grid.rgb[i * 3 + 1] - grid.rgb[j * 3 + 1]),
          Math.abs(grid.rgb[i * 3 + 2] - grid.rgb[j * 3 + 2]),
          Math.abs(grid.alpha[i] - grid.alpha[j]),
        );
      }
      out[i] = contrast <= limit ? 1 : 0;
    }
  }
  return out;
}

export function downsample(frame) {
  const { width, height, data } = frame;
  const bw = Math.ceil(width / BLOCK);
  const bh = Math.ceil(height / BLOCK);
  const sums = new Float64Array(bw * bh * 4);
  const counts = new Uint32Array(bw * bh);
  for (let y = 0; y < height; y += 1) {
    const by = (y / BLOCK) | 0;
    for (let x = 0; x < width; x += 1) {
      const bx = (x / BLOCK) | 0;
      const cell = by * bw + bx;
      const p = (y * width + x) * 4;
      const a = data[p + 3] / 255;
      sums[cell * 4] += data[p] * a + 255 * (1 - a);
      sums[cell * 4 + 1] += data[p + 1] * a + 255 * (1 - a);
      sums[cell * 4 + 2] += data[p + 2] * a + 255 * (1 - a);
      sums[cell * 4 + 3] += data[p + 3];
      counts[cell] += 1;
    }
  }
  const rgb = new Uint8Array(bw * bh * 3);
  const alpha = new Float32Array(bw * bh);
  for (let cell = 0; cell < counts.length; cell += 1) {
    const n = counts[cell] || 1;
    rgb[cell * 3] = Math.round(sums[cell * 4] / n);
    rgb[cell * 3 + 1] = Math.round(sums[cell * 4 + 1] / n);
    rgb[cell * 3 + 2] = Math.round(sums[cell * 4 + 2] / n);
    alpha[cell] = sums[cell * 4 + 3] / n;
  }
  return { width: bw, height: bh, rgb, alpha };
}

/**
 * @param {Frame} a baseline frame
 * @param {Frame} b candidate frame
 * @param {{grid?: number, perceptible?: number, diff?: boolean}} [options] grid = region grid (default 32)
 * @returns {Comparison}
 */
export function compareFrames(a, b, options = {}) {
  const perceptible = options.perceptible ?? PERCEPTIBLE;
  const wantDiff = options.diff !== false;

  const sizeMatch = a.width === b.width && a.height === b.height;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const inkA = inkMask({ width: a.width, height: a.height, data: a.data });
  const inkB = inkMask({ width: b.width, height: b.height, data: b.data });
  const dilA = dilate(inkA, a.width, a.height);
  const dilB = dilate(inkB, b.width, b.height);

  let lostInk = 0;
  let gainedInk = 0;
  let inkTotalA = 0;
  let inkTotalB = 0;
  let changed = 0;

  const gridN = options.grid ?? REGION_GRID;
  const cellW = Math.max(1, Math.ceil(width / gridN));
  const cellH = Math.max(1, Math.ceil(height / gridN));
  const cells = new Float64Array(gridN * gridN);
  const cellTotals = new Float64Array(gridN * gridN);
  let strongPixels = 0;

  const diff = wantDiff
    ? { width, height, data: new Uint8ClampedArray(width * height * 4) }
    : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ai = y * a.width + x;
      const bi = y * b.width + x;
      const ia = inkA[ai];
      const ib = inkB[bi];
      if (ia) inkTotalA += 1;
      if (ib) inkTotalB += 1;
      const lost = ia && !dilB[bi];
      const gained = ib && !dilA[ai];
      if (lost) lostInk += 1;
      if (gained) gainedInk += 1;
      if (lost || gained) {
        changed += 1;
        strongPixels += 1;
        cells[Math.floor(y / cellH) * gridN + Math.floor(x / cellW)] += 1;
      }
      cellTotals[Math.floor(y / cellH) * gridN + Math.floor(x / cellW)] += 1;
      if (diff && (lost || gained)) {
        const o = (y * width + x) * 4;
        if (lost) {
          diff.data[o] = 220;
          diff.data[o + 1] = 38;
          diff.data[o + 2] = 38;
        } else {
          diff.data[o] = 38;
          diff.data[o + 1] = 90;
          diff.data[o + 2] = 220;
        }
        diff.data[o + 3] = 255;
      }
    }
  }

  const da = downsample(a);
  const db = downsample(b);
  const bw = Math.min(da.width, db.width);
  const bh = Math.min(da.height, db.height);
  const blockInkA = new Uint8Array(bw * bh);
  const blockInkB = new Uint8Array(bw * bh);
  for (let i = 0; i < blockInkA.length; i += 1) {
    blockInkA[i] = da.alpha[i] >= INK_ALPHA ? 1 : 0;
    blockInkB[i] = db.alpha[i] >= INK_ALPHA ? 1 : 0;
  }
  const blockDilA = dilate(blockInkA, bw, bh);
  const blockDilB = dilate(blockInkB, bw, bh);
  let lostBlocks = 0;
  let gainedBlocks = 0;
  const colourHist = new Uint32Array(256);
  let colourBlocks = 0;
  let colourOver = 0;
  // Colour is only compared where neither image has an edge. Block means along a
  // silhouette move by tens of levels for a 0.4px shift; averaging them in turned
  // every optimisation into a false positive. Edges are the ink metric's job.
  const flatA = flatness(da, bw, bh);
  const flatB = flatness(db, bw, bh);
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const i = y * bw + x;
      const lost = blockInkA[i] && !blockDilB[i];
      const gained = blockInkB[i] && !blockDilA[i];
      if (lost) lostBlocks += 1;
      if (gained) gainedBlocks += 1;
      if (blockDilA[i] && blockDilB[i] && flatA[i] && flatB[i]) {
        const delta = Math.max(
          Math.abs(da.rgb[i * 3] - db.rgb[i * 3]),
          Math.abs(da.rgb[i * 3 + 1] - db.rgb[i * 3 + 1]),
          Math.abs(da.rgb[i * 3 + 2] - db.rgb[i * 3 + 2]),
        );
        colourHist[delta] += 1;
        colourBlocks += 1;
        if (delta > perceptible) {
          colourOver += 1;
          if (diff) {
            const sx = x * BLOCK + 1;
            const sy = y * BLOCK + 1;
            if (sx < width && sy < height) {
              const o = (sy * width + sx) * 4;
              diff.data[o] = 230;
              diff.data[o + 1] = 170;
              diff.data[o + 2] = 20;
              diff.data[o + 3] = 255;
            }
          }
        }
      }
    }
  }

  // Scatter strong colour changes back onto the pixel grid so ink loss and paint
  // drift are measured in the same unit: "how much of this region changed".
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      if (!blockDilA[y * bw + x] || !blockDilB[y * bw + x]) continue;
      const delta = Math.max(
        Math.abs(da.rgb[(y * bw + x) * 3] - db.rgb[(y * bw + x) * 3]),
        Math.abs(da.rgb[(y * bw + x) * 3 + 1] - db.rgb[(y * bw + x) * 3 + 1]),
        Math.abs(da.rgb[(y * bw + x) * 3 + 2] - db.rgb[(y * bw + x) * 3 + 2]),
      );
      if (delta <= STRONG) continue;
      for (let sy = 0; sy < BLOCK; sy += 1) {
        const py = y * BLOCK + sy;
        if (py >= height) break;
        for (let sx = 0; sx < BLOCK; sx += 1) {
          const px = x * BLOCK + sx;
          if (px >= width) break;
          strongPixels += 1;
          cells[Math.floor(py / cellH) * gridN + Math.floor(px / cellW)] += 1;
        }
      }
    }
  }

  const worstCells = [];
  for (let cy = 0; cy < gridN; cy += 1) {
    for (let cx = 0; cx < gridN; cx += 1) {
      const idx = cy * gridN + cx;
      const total = cellTotals[idx];
      if (total === 0 || cells[idx] === 0) continue;
      worstCells.push({
        x: cx,
        y: cy,
        ratio: cells[idx] / total,
        changed: cells[idx],
        total,
      });
    }
  }
  worstCells.sort((p, q) => q.ratio - p.ratio || q.changed - p.changed);

  const total = width * height;
  return {
    sizeMatch,
    widthA: a.width,
    heightA: a.height,
    widthB: b.width,
    heightB: b.height,
    inkA: inkTotalA,
    inkB: inkTotalB,
    lostInk,
    gainedInk,
    lostRatio: inkTotalA === 0 ? 0 : lostInk / inkTotalA,
    gainedRatio: inkTotalB === 0 ? 0 : gainedInk / inkTotalB,
    lostBlocks,
    gainedBlocks,
    colourP99: percentile(colourHist, colourBlocks, 0.99),
    colourMax: maxIndex(colourHist),
    colourChangedRatio: colourBlocks === 0 ? 0 : colourOver / colourBlocks,
    changedPixels: changed,
    changedRatio: total === 0 ? 0 : changed / total,
    strongPixels,
    strongRatio: total === 0 ? 0 : strongPixels / total,
    worstCells: worstCells.slice(0, 3),
    diff,
  };
}

/**
 * @param {Uint32Array} hist
 * @param {number} total
 * @param {number} q
 * @returns {number}
 */
export function percentile(hist, total, q) {
  if (total === 0) return 0;
  const target = total * q;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    seen += hist[i];
    if (seen >= target) return i;
  }
  return hist.length - 1;
}

/**
 * @param {Uint32Array} hist
 * @returns {number}
 */
export function maxIndex(hist) {
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    if (hist[i] > 0) return i;
  }
  return 0;
}
