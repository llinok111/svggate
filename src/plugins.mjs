/**
 * The plugin pipeline, one plugin at a time.
 *
 * svgo applies `preset-default` as a single pass over one parsed tree. To say
 * *which* plugin caused a regression we have to break that pass apart: optimise,
 * serialise, re-parse, repeat. The cost is re-serialisation between steps; the
 * benefit is attribution, which is the whole point.
 *
 * `PRESET_DEFAULT` mirrors `plugins/preset-default.js` in svgo v4.1.0. It is not
 * imported (svgo's `exports` map exposes only the package root) — so
 * `test/preset-parity.test.mjs` proves the mirror stays equivalent by comparing
 * the stepped result against a real `preset-default` run on every fixture.
 * If svgo reorders or adds a plugin, that test fails before users notice.
 */

import { optimize } from 'svgo';

export const PRESET_DEFAULT = [
  'removeDoctype',
  'removeXMLProcInst',
  'removeComments',
  'removeDeprecatedAttrs',
  'removeMetadata',
  'removeEditorsNSData',
  'cleanupAttrs',
  'mergeStyles',
  'inlineStyles',
  'minifyStyles',
  'cleanupIds',
  'removeUselessDefs',
  'cleanupNumericValues',
  'convertColors',
  'removeUnknownsAndDefaults',
  'removeNonInheritableGroupAttrs',
  'removeUselessStrokeAndFill',
  'cleanupEnableBackground',
  'removeHiddenElems',
  'removeEmptyText',
  'convertShapeToPath',
  'convertEllipseToCircle',
  'moveElemsAttrsToGroup',
  'moveGroupAttrsToElems',
  'collapseGroups',
  'convertPathData',
  'convertTransform',
  'removeEmptyAttrs',
  'removeEmptyContainers',
  'mergePaths',
  'removeUnusedNS',
  'sortAttrs',
  'sortDefsChildren',
  'removeDesc',
];

/**
 * Run exactly one plugin, keeping the document as a string between steps.
 * @param {string} svg
 * @param {string} name
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function step(svg, name, params) {
  const plugins = params ? [{ name, params }] : [name];
  return optimize(svg, { plugins, multipass: false }).data;
}

/**
 * Run a plugin list as one svgo invocation (the artifact users would ship).
 * @param {string} svg
 * @param {string[]} plugins
 * @param {boolean} [multipass]
 * @returns {string}
 */
export function runAll(svg, plugins, multipass = false) {
  return optimize(svg, { plugins, multipass }).data;
}

/**
 * Resolve a user-facing plugin selection into a concrete ordered list.
 * @param {string[] | undefined} requested
 * @param {object} [options]
 * @param {number} [options.limit] keep only the first N plugins
 * @returns {string[]}
 */
export function resolvePlugins(requested, options = {}) {
  const list =
    requested && requested.length > 0
      ? requested[0] === 'preset-default'
        ? PRESET_DEFAULT
        : requested
      : PRESET_DEFAULT;
  const limit = options.limit;
  if (typeof limit === 'number' && limit >= 0) return list.slice(0, limit);
  return [...list];
}
