/**
 * Report rendering. Two audiences, two formats: a terminal table for the person
 * running it, JSON for the CI job that has to act on it.
 *
 * The table has two verdict columns on purpose. `delta` answers "did this plugin
 * move the picture"; `state` answers "is the file wrong right now". After a
 * regression is introduced, every later plugin has a bad `state` and a clean
 * `delta` — collapsing them into one column is what makes attribution useless.
 */

const ICON = { ok: 'ok', review: 'WARN', broken: 'FAIL' };

/**
 * @param {import('./gate.mjs').GateReport} report
 * @returns {Record<string, unknown>}
 */
export function toJson(report) {
  return {
    verdict: report.verdict,
    sizes: report.sizes,
    input: report.input,
    plugins: report.plugins,
    scales: report.scales,
    render: report.input.render,
    density: report.input.density,
    thresholds: report.thresholds,
    steps: report.steps.map((entry) => ({
      index: entry.index,
      plugin: entry.plugin,
      verdict: entry.verdict,
      stateVerdict: entry.stateVerdict ?? null,
      bytes: entry.bytes,
      bytesSaved: entry.bytesSaved ?? null,
      ms: entry.ms,
      error: entry.error,
      findings: entry.findings,
      delta: entry.delta.map((p) => pixels(p)),
      cumulative: entry.cumulative.map((p) => pixels(p)),
    })),
    blamed: report.blamed,
    dropped: report.dropped,
    artifact: report.artifact
      ? { verdict: report.artifact.verdict, findings: report.artifact.findings, pixels: report.artifact.pixels }
      : null,
  };
}

/**
 * @param {{width: number, verdict: string, metrics: import('./compare.mjs').Comparison}} point
 */
function pixels(point) {
  const m = point.metrics;
  return {
    width: point.width,
    verdict: point.verdict,
    sizeMatch: m.sizeMatch,
    inkA: m.inkA,
    lostInk: m.lostInk,
    gainedInk: m.gainedInk,
    lostBlocks: m.lostBlocks,
    gainedBlocks: m.gainedBlocks,
    lostRatio: round(m.lostRatio, 6),
    gainedRatio: round(m.gainedRatio, 6),
    colourP99: m.colourP99,
    colourMax: m.colourMax,
    colourChangedRatio: round(m.colourChangedRatio, 6),
    changedPixels: m.changedPixels,
    changedRatio: round(m.changedRatio, 6),
    strongPixels: m.strongPixels,
    strongRatio: round(m.strongRatio, 6),
    worstCells: m.worstCells.map((c) => ({ x: c.x, y: c.y, ratio: round(c.ratio, 4), changed: c.changed })),
  };
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {import('./gate.mjs').GateReport} report
 * @param {{name?: string}} [options]
 * @returns {string}
 */
export function toMarkdown(report, options = {}) {
  const name = options.name ?? 'svg';
  /** @type {string[]} */
  const lines = [];
  lines.push(`## ${name} — ${report.verdict.toUpperCase()}`);
  lines.push('');
  lines.push(
    `input ${report.sizes.before}B (${report.input.width}x${report.input.height} intrinsic, viewBox mapped to ${report.input.render}, ${report.input.elements} drawable, ${report.input.ids} ids)` +
      (report.sizes.after === null ? '' : ` → artifact ${report.sizes.after}B`),
  );
  lines.push('');
  lines.push('| # | plugin | bytes | delta | state | evidence |');
  lines.push('|---|---|---|---|---|---|');
  for (const entry of report.steps) {
    const evidence = entry.error
      ? `error: ${entry.error}`
      : reasons(entry).slice(0, 2).join('; ').replace(/\|/g, '\\|') || '—';
    lines.push(
      `| ${entry.index} | \`${entry.plugin}\` | ${entry.bytes} | ${ICON[entry.verdict] ?? entry.verdict} | ${ICON[entry.stateVerdict ?? 'ok'] ?? entry.stateVerdict} | ${evidence} |`,
    );
  }
  if (report.blamed.length > 0) {
    lines.push('');
    lines.push('### Attributed');
    for (const blamed of report.blamed) {
      lines.push(`- \`${blamed.plugin}\` (${blamed.verdict})`);
      for (const reason of blamed.reasons) lines.push(`  - ${reason}`);
    }
  }
  if (report.dropped.length > 0) {
    lines.push('');
    lines.push('### Dropped to keep the artifact clean');
    lines.push(`- ${report.dropped.map((p) => `\`${p}\``).join(', ')}`);
  }
  if (report.artifact) {
    lines.push('');
    lines.push(`Artifact verdict: **${report.artifact.verdict}** (pixels: ${report.artifact.pixels})`);
    for (const finding of report.artifact.findings) {
      lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {import('./gate.mjs').StepReport} entry
 * @returns {string[]}
 */
function reasons(entry) {
  /** @type {string[]} */
  const out = [];
  for (const finding of entry.findings) {
    if (finding.severity === 'info') continue;
    out.push(finding.message);
  }
  const worst = entry.delta
    .slice()
    .sort((a, b) => b.metrics.changedRatio - a.metrics.changedRatio)[0];
  if (worst && worst.verdict !== 'ok') {
    const m = worst.metrics;
    if (!m.sizeMatch) out.push(`render size ${m.widthA}x${m.heightA} -> ${m.widthB}x${m.heightB}`);
    if (m.lostInk > 0) out.push(`${m.lostInk}px lost`);
    if (m.gainedInk > 0) out.push(`${m.gainedInk}px gained`);
    if (m.colourP99 > 0) out.push(`colour Δ${m.colourP99}`);
    const region = m.worstCells[0];
    if (region) out.push(`region ${(region.ratio * 100).toFixed(0)}%`);
    out.push(`${(m.changedRatio * 100).toFixed(2)}% pixels`);
  }
  return out;
}
