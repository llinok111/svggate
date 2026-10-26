/**
 * Command line entry point.
 *
 * Exit codes are a contract, because the primary consumer is CI:
 *   0  no finding at or above --fail-on
 *   1  at least one finding at or above --fail-on
 *   2  usage / IO / render error (never silently swallowed)
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';

import { gate } from './gate.mjs';
import { toJson, toMarkdown } from './report.mjs';

const HELP = `svggate — render-verified gate for SVG optimization

Usage
  svggate check <file-or-dir ...> [options]

Options
  --strategy <mode>   report | drop | none   (default: report)
                        report  verify the full preset, ship nothing
                        drop    drop offending plugins until the artifact is safe
                        none    attribution only, no artifact
  --plugins <list>    comma separated plugin names, or "preset-default"
  --scales <list>     multipliers on the planned render size (default: 1)
  --fail-on <level>   broken | review        (default: broken)
  --json <file>       write the machine-readable report
  --md <file>         write the markdown report
  --out <dir>         write the produced artifact as <name>.optimized.svg
  --diff-dir <dir>    write per-step diff images for anything not "ok"
  --system-fonts      load system fonts (131ms/render; needed to see glyph changes)
  --multipass         multipass for the shipped artifact
  --quiet             only print failures
  --version
  --help

Exit codes
  0 ok · 1 finding >= --fail-on · 2 usage, IO or render error
`;

const SEVERITY = { broken: 0, review: 1 };

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return args.length === 0 ? 2 : 0;
  }
  if (args.includes('--version')) {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const command = args[0];
  if (command !== 'check') {
    process.stderr.write(`svggate: unknown command "${command}"\n\n${HELP}`);
    return 2;
  }

  const options = parseOptions(args.slice(1));
  if (options.error) {
    process.stderr.write(`svggate: ${options.error}\n`);
    return 2;
  }
  const targets = expand(options.files);
  if (targets.length === 0) {
    process.stderr.write('svggate: no .svg files matched\n');
    return 2;
  }

  /** @type {any[]} */
  const reports = [];
  let worstExit = 0;
  for (const file of targets) {
    let svg;
    try {
      svg = readFileSync(file, 'utf8');
    } catch (error) {
      process.stderr.write(`svggate: cannot read ${file}: ${error.message}\n`);
      worstExit = 2;
      continue;
    }
    let report;
    try {
      report = gate(svg, {
        strategy: options.strategy,
        scales: options.scales,
        plugins: options.plugins,
        multipass: options.multipass,
        systemFonts: options.systemFonts,
        onDiff: options.diffDir
          ? (plugin, width, metrics) => writeDiff(options.diffDir, file, plugin, width, metrics)
          : undefined,
      });
    } catch (error) {
      process.stderr.write(`svggate: ${file}: ${error.message}\n`);
      worstExit = 2;
      continue;
    }
    reports.push({ file, report });
    const level = SEVERITY[options.failOn];
    if (level !== undefined && SEVERITY[report.verdict] !== undefined) {
      if (SEVERITY[report.verdict] <= level) worstExit = Math.max(worstExit, 1);
    }
    if (options.strategy === 'drop' && options.out && report.artifact) {
      mkdirSync(options.out, { recursive: true });
      const target = join(options.out, `${basename(file, extname(file))}.optimized.svg`);
      writeFileSync(target, report.artifact.svg);
    }
  }

  if (!options.quiet || worstExit !== 0) {
    for (const { file, report } of reports) {
      process.stdout.write(toMarkdown(report, { name: file }));
    }
  }
  if (options.json) {
    mkdirSync(dirname(resolve(options.json)), { recursive: true });
    writeFileSync(
      options.json,
      `${JSON.stringify(
        reports.map(({ file, report }) => ({ file, ...toJson(report) })),
        null,
        2,
      )}\n`,
    );
  }
  if (options.md) {
    mkdirSync(dirname(resolve(options.md)), { recursive: true });
    writeFileSync(
      options.md,
      reports.map(({ file, report }) => toMarkdown(report, { name: file })).join('\n'),
    );
  }
  return worstExit;
}

/**
 * @param {import('./compare.mjs').Comparison} metrics
 * @param {string} dir
 * @param {string} file
 * @param {string} plugin
 * @param {number} width
 */
function writeDiff(dir, file, plugin, width, metrics) {
  if (!metrics.diff) return;
  mkdirSync(dir, { recursive: true });
  const png = new PNG({ width: metrics.diff.width, height: metrics.diff.height });
  png.data = Buffer.from(metrics.diff.data);
  const name = `${basename(file, extname(file))}.${plugin}.${width}.diff.png`;
  writeFileSync(join(dir, name), PNG.sync.write(png));
}

/**
 * @param {string[]} argv
 */
function parseOptions(argv) {
  /** @type {any} */
  const options = {
    files: [],
    strategy: 'report',
    scales: undefined,
    plugins: undefined,
    failOn: 'broken',
    json: null,
    md: null,
    out: null,
    diffDir: null,
    systemFonts: false,
    multipass: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--strategy':
        options.strategy = argv[++i];
        if (!['report', 'drop', 'none'].includes(options.strategy)) {
          return { error: `--strategy must be report|drop|none` };
        }
        break;
      case '--plugins':
        options.plugins = String(argv[++i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--scales':
        options.scales = String(argv[++i] ?? '')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (options.scales.length === 0) return { error: '--scales needs positive numbers' };
        break;
      case '--fail-on':
        options.failOn = argv[++i];
        if (!['broken', 'review'].includes(options.failOn)) {
          return { error: '--fail-on must be broken|review' };
        }
        break;
      case '--json':
        options.json = argv[++i];
        break;
      case '--md':
        options.md = argv[++i];
        break;
      case '--out':
        options.out = argv[++i];
        break;
      case '--diff-dir':
        options.diffDir = argv[++i];
        break;
      case '--system-fonts':
        options.systemFonts = true;
        break;
      case '--multipass':
        options.multipass = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
        options.files.push(arg);
    }
  }
  if (options.files.length === 0) return { error: 'no input files' };
  return options;
}

/**
 * Expand directories and files into a flat list of .svg paths.
 * @param {string[]} inputs
 * @returns {string[]}
 */
export function expand(inputs) {
  /** @type {string[]} */
  const out = [];
  for (const input of inputs) {
    let stats;
    try {
      stats = statSync(input);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(input)) {
        out.push(...expand([join(input, name)]));
      }
    } else if (extname(input).toLowerCase() === '.svg') {
      out.push(input);
    }
  }
  return out.sort();
}
