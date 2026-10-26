/**
 * The gate: replay optimisation one plugin at a time, verify each step against
 * the step before it (who moved the picture) and against the untouched baseline
 * (what the picture looks like now), then verify the artifact that would ship.
 *
 * Attribution needs the step-to-step delta. Comparing every step to the baseline
 * was the first implementation and it blamed all twenty plugins after the one
 * that actually broke the file — a report that is technically true and
 * practically useless.
 *
 * Verdict vocabulary is deliberately small:
 *   ok      nothing measurable changed
 *   review  changed, but inside tolerance, or only a warning class fired
 *   broken  dangled id, lost script/animation/text, moved ink, drifted paint
 */

import { compareFrames } from './compare.mjs';
import { PRESET_DEFAULT, resolvePlugins, runAll, step as runStep } from './plugins.mjs';
import { planSize, renderIntrinsic, renderSized } from './render.mjs';
import { diffSnapshots, snapshot } from './structural.mjs';

export const DEFAULT_SCALES = [1];

/**
 * Thresholds are calibrated on test/corpus (real-world SVGs) plus the two
 * documented upstream regressions. See README "How the thresholds were measured".
 *
 * Ratios are relative to painted area, never to the frame: a mostly empty canvas
 * must not dilute a lost glyph into nothing.
 */
export const DEFAULT_THRESHOLDS = {
  lostInkPixels: 12,
  lostInkRatio: 0.0005,
  gainedInkPixels: 12,
  gainedInkRatio: 0.0005,
  colourP99: 24,
  colourChangedRatio: 0.02,
  colourReviewP99: 10,
  colourReviewRatio: 0.005,
  changedRatio: 0.004,
  reviewRatio: 0.0002,
  regionRatio: 0.2,
  regionPixels: 24,
};

const RANK = { ok: 0, review: 1, broken: 2 };

/**
 * @param {'ok' | 'review' | 'broken'} a
 * @param {'ok' | 'review' | 'broken'} b
 * @returns {'ok' | 'review' | 'broken'}
 */
export function worst(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * @param {import('./compare.mjs').Comparison} metrics
 * @param {typeof DEFAULT_THRESHOLDS} [t]
 * @returns {'ok' | 'review' | 'broken'}
 */
export function pixelVerdict(metrics, t = DEFAULT_THRESHOLDS) {
  if (!metrics.sizeMatch) return 'broken';
  const lost = metrics.lostInk >= t.lostInkPixels && metrics.lostRatio >= t.lostInkRatio;
  const gained =
    metrics.gainedInk >= t.gainedInkPixels && metrics.gainedRatio >= t.gainedInkRatio;
  const colour =
    metrics.colourP99 >= t.colourP99 && metrics.colourChangedRatio >= t.colourChangedRatio;
  // A vanishing 2-unit dot is invisible to every global ratio; it is not
  // invisible to the region it used to occupy.
  const region = metrics.worstCells[0];
  const localised =
    region !== undefined && region.ratio >= t.regionRatio && region.changed >= t.regionPixels;
  if (lost || gained || colour || localised || metrics.changedRatio >= t.changedRatio) {
    return 'broken';
  }
  const colourReview =
    metrics.colourP99 >= t.colourReviewP99 && metrics.colourChangedRatio >= t.colourReviewRatio;
  if (colourReview || metrics.changedRatio >= t.reviewRatio) return 'review';
  return 'ok';
}

/**
 * @param {import('./structural.mjs').Finding[]} findings
 * @returns {'ok' | 'review' | 'broken'}
 */
export function structuralVerdict(findings) {
  let verdict = 'ok';
  for (const finding of findings) {
    if (finding.severity === 'error') return 'broken';
    if (finding.severity === 'warn') verdict = worst(verdict, 'review');
  }
  return verdict;
}

/**
 * @typedef {object} GateOptions
 * @property {string[]} [plugins]
 * @property {number[]} [scales] render scales applied to the planned pixel size
 * @property {'report' | 'drop' | 'none'} [strategy]
 * @property {boolean} [multipass]
 * @property {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @property {boolean} [systemFonts]
 * @property {(plugin: string, width: number, metrics: import('./compare.mjs').Comparison) => void} [onDiff]
 */

/**
 * @param {string} svg
 * @param {GateOptions} [options]
 * @returns {GateReport}
 */
export function gate(svg, options = {}) {
  const plugins = resolvePlugins(options.plugins);
  const scales = options.scales ?? DEFAULT_SCALES;
  const strategy = options.strategy ?? 'report';
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const systemFonts = options.systemFonts === true;

  const baseSnapshot = snapshot(svg);
  const baseIntrinsic = renderIntrinsic(svg, { systemFonts });
  const plan = planSize(baseSnapshot);
  /** @type {{width: number, height: number, frame: any}[]} */
  const sizes = scales.map((scale) => {
    const size = {
      width: Math.max(24, Math.round(plan.width * scale)),
      height: Math.max(24, Math.round(plan.height * scale)),
    };
    return { ...size, frame: renderSized(svg, size, { systemFonts }) };
  });

  /** @type {StepReport[]} */
  const steps = [];
  let current = svg;
  let currentSnapshot = baseSnapshot;
  let currentFrames = sizes.map((s) => ({ width: s.width, frame: s.frame }));

  for (const plugin of plugins) {
    const started = performance.now();
    /** @type {StepReport} */
    const entry = {
      index: steps.length + 1,
      plugin,
      bytes: current.length,
      bytesSaved: 0,
      ms: 0,
      verdict: 'ok',
      blame: 'ok',
      stateVerdict: 'ok',
      findings: [],
      delta: [],
      cumulative: [],
      error: null,
    };
    try {
      const next = runStep(current, plugin);
      entry.bytes = next.length;
      entry.bytesSaved = current.length - next.length;
      const afterSnapshot = snapshot(next);
      // A finding is blamed on the step that *introduced* it, so the state is
      // diffed against the baseline and everything already present one step
      // earlier is filtered out. Diffing step-to-step instead re-reported a
      // dangling reference on every plugin after the one that broke it.
      const prevState = diffSnapshots(baseSnapshot, currentSnapshot);
      const stateFindings = diffSnapshots(baseSnapshot, afterSnapshot);
      const known = new Set(prevState.map((finding) => `${finding.code}|${finding.message}`));
      entry.findings = stateFindings.filter(
        (finding) => !known.has(`${finding.code}|${finding.message}`),
      );
      entry.stateFindings = stateFindings;
      const structuralDelta = structuralVerdict(entry.findings);
      const structuralState = structuralVerdict(stateFindings);

      let pixelDelta = 'ok';
      let pixelState = 'ok';
      const lastFrames = [];
      for (const size of sizes) {
        const frame = renderSized(next, size, { systemFonts });
        lastFrames.push(frame);
        const prev = currentFrames.find((f) => f.width === size.width);
        const deltaMetrics = compareFrames(prev.frame, frame, {
          diff: options.onDiff !== undefined,
        });
        const cumulativeMetrics = compareFrames(size.frame, frame, { diff: false });
        const deltaVerdict = pixelVerdict(deltaMetrics, thresholds);
        const cumulativeVerdict = pixelVerdict(cumulativeMetrics, thresholds);
        entry.delta.push({ width: size.width, metrics: deltaMetrics, verdict: deltaVerdict });
        entry.cumulative.push({
          width: size.width,
          metrics: cumulativeMetrics,
          verdict: cumulativeVerdict,
        });
        if (RANK[deltaVerdict] > RANK[pixelDelta]) pixelDelta = deltaVerdict;
        if (RANK[cumulativeVerdict] > RANK[pixelState]) pixelState = cumulativeVerdict;
        if (options.onDiff && deltaVerdict !== 'ok') {
          options.onDiff(plugin, size.width, deltaMetrics);
        }
      }
      entry.verdict = worst(structuralDelta, pixelDelta);
      entry.blame = entry.verdict;
      entry.stateVerdict = worst(structuralState, pixelState);
      current = next;
      currentSnapshot = afterSnapshot;
      // Reuse the frames already rendered for this step: re-rendering here cost
      // one extra full rasterisation per plugin for no new information.
      currentFrames = entry.delta.map((point, i) => ({
        width: sizes[i].width,
        frame: lastFrames[i],
      }));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.verdict = 'broken';
      entry.blame = 'broken';
      entry.ms = Number((performance.now() - started).toFixed(1));
      steps.push(entry);
      break;
    }
    entry.ms = Number((performance.now() - started).toFixed(1));
    steps.push(entry);
  }

  const blamed = steps
    .filter((entry) => entry.blame !== 'ok')
    .map((entry) => ({
      plugin: entry.plugin,
      verdict: entry.blame,
      bytesSaved: entry.bytesSaved,
      reasons: reasonsFor(entry, thresholds),
    }));

  let artifact = null;
  let dropped = [];
  let artifactReport = null;
  if (strategy !== 'none') {
    let candidates = plugins;
    if (strategy === 'drop' && blamed.length > 0) {
      candidates = plugins.filter((name) => !blamed.some((b) => b.plugin === name));
      let attempt = 0;
      while (candidates.length > 0 && attempt < 3) {
        attempt += 1;
        const candidateSvg = runAll(svg, candidates, options.multipass === true);
        const verification = verifyArtifact(
          svg,
          candidateSvg,
          sizes,
          thresholds,
          systemFonts,
          baseSnapshot,
        );
        artifact = candidateSvg;
        artifactReport = verification;
        if (verification.verdict !== 'broken') break;
        const brokenStep = verification.brokenPlugin;
        if (!brokenStep) break;
        candidates = candidates.filter((name) => name !== brokenStep);
        artifact = null;
        artifactReport = null;
      }
      dropped = plugins.filter((name) => !candidates.includes(name));
    } else {
      artifact = runAll(svg, plugins, options.multipass === true);
      artifactReport = verifyArtifact(svg, artifact, sizes, thresholds, systemFonts, baseSnapshot);
    }
  }

  return {
    verdict: artifactReport
      ? artifactReport.verdict
      : steps.some((s) => s.blame === 'broken')
        ? 'broken'
        : steps.some((s) => s.blame === 'review')
          ? 'review'
          : 'ok',
    sizes: { before: svg.length, after: artifact ? artifact.length : null },
    input: {
      bytes: svg.length,
      width: baseIntrinsic.width,
      height: baseIntrinsic.height,
      viewBox: baseSnapshot.root.viewBox,
      elements: baseSnapshot.drawableCount,
      ids: baseSnapshot.ids.length,
      render: `${plan.width}x${plan.height}`,
      density: Number(plan.density.toFixed(3)),
    },
    plugins,
    scales,
    thresholds,
    steps,
    blamed,
    dropped,
    artifact: artifact ? { svg: artifact, ...artifactReport } : null,
  };
}

/**
 * Verify a candidate artifact against the untouched baseline.
 * @param {string} original
 * @param {string} candidate
 * @param {{width: number, height: number, frame: any}[]} sizes
 * @param {typeof DEFAULT_THRESHOLDS} thresholds
 * @param {boolean} systemFonts
 * @param {import('./structural.mjs').Snapshot} [baseSnapshot]
 */
function verifyArtifact(original, candidate, sizes, thresholds, systemFonts, baseSnapshot) {
  const before = baseSnapshot ?? snapshot(original);
  const findings = diffSnapshots(before, snapshot(candidate));
  const structural = structuralVerdict(findings);
  let pixel = 'ok';
  for (const size of sizes) {
    const metrics = compareFrames(size.frame, renderSized(candidate, size, { systemFonts }), {
      diff: false,
    });
    const verdict = pixelVerdict(metrics, thresholds);
    if (RANK[verdict] > RANK[pixel]) pixel = verdict;
  }
  return { verdict: worst(structural, pixel), findings, pixels: pixel, brokenPlugin: null };
}

/**
 * Reasons for a step verdict, derived from the same numbers the verdict used.
 * No claim appears here that a metric did not produce.
 * @param {StepReport} entry
 * @param {typeof DEFAULT_THRESHOLDS} [t]
 * @returns {string[]}
 */
export function reasonsFor(entry, t = DEFAULT_THRESHOLDS) {
  /** @type {string[]} */
  const reasons = [];
  if (entry.error) reasons.push(`step failed: ${entry.error}`);
  for (const finding of entry.findings) {
    if (finding.severity === 'info') continue;
    reasons.push(
      `${finding.code}: ${finding.message}${finding.detail ? ` (${finding.detail})` : ''}`,
    );
  }
  const worstPixels = entry.delta
    .slice()
    .sort((a, b) => b.metrics.changedRatio - a.metrics.changedRatio)[0];
  if (worstPixels) {
    const m = worstPixels.metrics;
    if (!m.sizeMatch) {
      reasons.push(`render size changed: ${m.widthA}x${m.heightA} -> ${m.widthB}x${m.heightB}`);
    }
    if (m.lostInk >= t.lostInkPixels && m.lostRatio >= t.lostInkRatio) {
      reasons.push(
        `${m.lostInk}px of paint disappeared (${(m.lostRatio * 100).toFixed(2)}% of ink) at ${worstPixels.width}px wide`,
      );
    }
    if (m.gainedInk >= t.gainedInkPixels && m.gainedRatio >= t.gainedInkRatio) {
      reasons.push(
        `${m.gainedInk}px of paint appeared (${(m.gainedRatio * 100).toFixed(2)}% of ink) at ${worstPixels.width}px wide`,
      );
    }
    if (m.colourP99 >= t.colourReviewP99 && m.colourChangedRatio >= t.colourReviewRatio) {
      reasons.push(
        `paint drifted: p99 channel delta ${m.colourP99}/255 across ${(m.colourChangedRatio * 100).toFixed(1)}% of painted blocks at ${worstPixels.width}px wide`,
      );
    }
    const region = m.worstCells[0];
    if (region && region.ratio >= t.regionRatio * 0.5 && region.changed >= t.regionPixels && reasons.length === 0) {
      reasons.push(
        `localised change: ${region.changed}px (${(region.ratio * 100).toFixed(0)}% of region ${region.x},${region.y})`,
      );
    }
    if (reasons.length === 0 && m.changedRatio >= t.reviewRatio) {
      reasons.push(
        `${(m.changedRatio * 100).toFixed(3)}% of pixels changed at ${worstPixels.width}px wide`,
      );
    }
  }
  return reasons;
}

/**
 * @typedef {object} StepReport
 * @property {number} index
 * @property {string} plugin
 * @property {number} bytes
 * @property {number} bytesSaved
 * @property {number} ms
 * @property {'ok' | 'review' | 'broken'} verdict step-to-step verdict
 * @property {'ok' | 'review' | 'broken'} blame same as verdict, named for readers
 * @property {'ok' | 'review' | 'broken'} stateVerdict cumulative verdict vs baseline
 * @property {import('./structural.mjs').Finding[]} findings
 * @property {{width: number, metrics: import('./compare.mjs').Comparison, verdict: 'ok' | 'review' | 'broken'}[]} delta
 * @property {{width: number, metrics: import('./compare.mjs').Comparison, verdict: 'ok' | 'review' | 'broken'}[]} cumulative
 * @property {string | null} error
 *
 * @typedef {object} GateReport
 * @property {'ok' | 'review' | 'broken'} verdict
 * @property {{before: number, after: number | null}} sizes
 * @property {{bytes: number, width: number, height: number, viewBox: string | null, elements: number, ids: number, render: string, density: number}} input
 * @property {string[]} plugins
 * @property {number[]} scales
 * @property {typeof DEFAULT_THRESHOLDS} thresholds
 * @property {StepReport[]} steps
 * @property {{plugin: string, verdict: string, bytesSaved: number, reasons: string[]}[]} blamed
 * @property {{svg: string, verdict: string, findings: import('./structural.mjs').Finding[], pixels: string, brokenPlugin: string | null} | null} artifact
 * @property {string[]} dropped
 */

export { PRESET_DEFAULT };
