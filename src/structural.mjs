/**
 * Structural checks: the failures that pixels cannot see.
 *
 * A render comparison answers "is the picture different?". It cannot answer
 * "will this file still work in the places it is used?" — an SVG whose
 * `viewBox` was dropped renders identically in a fixed-size box and differently
 * in every other one; a dropped `<script>` renders identically forever, until
 * someone clicks.
 *
 * So the gate runs two independent passes and reports both. Structure first,
 * because structure explains pixels, not the other way round.
 */

import { optimize } from 'svgo';

const DRAWABLE = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'image',
  'use',
]);

const ANIMATION = new Set([
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'mpath',
]);

const REF_ATTRS = [
  'href',
  'xlink:href',
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'style',
  'begin',
  'end',
  'aria-labelledby',
  'aria-describedby',
];

/**
 * Parse an SVG document into the shape the checks need.
 * Uses svgo's own parser through a no-op visitor, so the tree we inspect is the
 * tree the optimizer sees — no second XML implementation to disagree with.
 * @param {string} svg
 * @returns {Snapshot}
 */
export function snapshot(svg) {
  /** @type {any} */
  let root = null;
  optimize(svg, {
    plugins: [
      {
        name: 'svggate-capture',
        fn: () => ({
          root: {
            enter(node) {
              root = node;
            },
          },
        }),
      },
    ],
  });
  if (!root || !root.children || root.children.length === 0) {
    throw new Error('svggate: no root element found');
  }
  // root.children can start with a doctype or an XML declaration; the <svg>
  // element is the first *element*, not the first child.
  const element = root.children.find((child) => child.type === 'element');
  if (!element) throw new Error('svggate: no <svg> element found');
  const state = {
    counts: new Map(),
    ids: new Set(),
    textNodes: new Map(),
    refs: /** @type {Ref[]} */ ([]),
    eventAttrs: 0,
    styleText: /** @type {string | null} */ (null),
    externalHrefs: 0,
    hasScript: false,
    animationCount: 0,
    drawableCount: 0,
    attributes: /** @type {Record<string, string>} */ ({}),
  };
  walk(element, null, state);

  const attrs = element.attributes ?? {};
  return {
    root: {
      name: element.name,
      viewBox: attrs.viewBox ?? null,
      width: attrs.width ?? null,
      height: attrs.height ?? null,
      preserveAspectRatio: attrs.preserveAspectRatio ?? null,
      xmlns: attrs.xmlns ?? null,
    },
    counts: Object.fromEntries(state.counts),
    ids: [...state.ids].sort(),
    refs: state.refs,
    eventAttrs: state.eventAttrs,
    styleText: state.styleText,
    externalHrefs: state.externalHrefs,
    hasScript: state.hasScript,
    animationCount: state.animationCount,
    drawableCount: state.drawableCount,
    textContent: [...state.textNodes.entries()]
      .map(([name, text]) => `${name}:${text}`)
      .join('|'),
  };
}

/**
 * @param {any} node
 * @param {any} parent
 * @param {any} state
 */
function walk(node, parent, state) {
  if (node.type === 'element') {
    const name = node.name;
    state.counts.set(name, (state.counts.get(name) ?? 0) + 1);
    if (DRAWABLE.has(name)) state.drawableCount += 1;
    if (ANIMATION.has(name)) state.animationCount += 1;
    if (name === 'script') state.hasScript = true;
    if (name === 'style') {
      const text = (node.children ?? [])
        .filter((child) => child.type === 'text')
        .map((child) => child.value)
        .join('');
      state.styleText = state.styleText === null ? text : `${state.styleText}\n${text}`;
      // Stylesheet selectors and url() references are real references: an
      // optimiser that renames an id must rewrite them too, or the drawing loses
      // its paint.
      for (const match of text.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g)) {
        state.refs.push({ id: match[1], attr: 'style', element: 'style', syntax: 'css url()' });
      }
      for (const match of text.matchAll(/(?:^|[},\s])#([A-Za-z_][\w-]*)\s*[,{]/g)) {
        state.refs.push({ id: match[1], attr: 'style', element: 'style', syntax: 'css selector' });
      }
    }
    const attrs = node.attributes ?? {};
    if (attrs.id) state.ids.add(attrs.id);
    for (const [attr, value] of Object.entries(attrs)) {
      if (/^on[a-z]/.test(attr)) state.eventAttrs += 1;
      if (attr === 'href' || attr === 'xlink:href') {
        if (/^(https?:)?\/\//.test(value) || /^data:/.test(value)) {
          state.externalHrefs += 1;
        }
      }
      if (REF_ATTRS.includes(attr)) collectRefs(value, attr, name, state.refs);
    }
  }
  if (node.type === 'text' && parent) {
    const text = String(node.value ?? '');
    if (text.trim() !== '') {
      state.textNodes.set(parent.name ?? 'root', text.trim());
    }
  }
  for (const child of node.children ?? []) walk(child, node, state);
}

/**
 * Extract id references from one attribute value.
 * Four syntaxes matter, and they fail differently: `url(#id)` in paint and
 * filter attributes, `#id` in href, `id.event` in SMIL timing, and bare id lists
 * in the ARIA relation attributes.
 * @param {string} value
 * @param {string} attr
 * @param {string} element
 * @param {Ref[]} out
 */
function collectRefs(value, attr, element, out) {
  for (const match of value.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g)) {
    out.push({ id: match[1], attr, element, syntax: 'url()' });
  }
  if (attr === 'href' || attr === 'xlink:href') {
    const match = /^#(.+)$/.exec(value.trim());
    if (match) out.push({ id: match[1], attr, element, syntax: 'href' });
  }
  if (attr === 'begin' || attr === 'end') {
    for (const part of value.split(';')) {
      const token = part.trim().replace(/^[+-]?\d*\.?\d*[a-z]*\s*/, '');
      const match = /^([A-Za-z_][\w.-]*)\.(begin|end|click|mouseover|repeat.*)$/.exec(token);
      if (match) out.push({ id: match[1], attr, element, syntax: 'SMIL timing' });
    }
  }
  if (attr === 'aria-labelledby' || attr === 'aria-describedby') {
    for (const id of value.trim().split(/\s+/)) {
      if (id) out.push({ id, attr, element, syntax: 'aria' });
    }
  }
  // A style="" attribute cannot hold a selector — only url(#id) matters there
  // (handled above). Parsing "#005ac3" as an id reference was the bug that made
  // every file using inlineStyles look broken.

}

/**
 * Compare two snapshots and return findings, most severe first.
 * @param {Snapshot} before
 * @param {Snapshot} after
 * @returns {Finding[]}
 */
export function diffSnapshots(before, after) {
  /** @type {Finding[]} */
  const findings = [];

  if (before.root.xmlns && !after.root.xmlns) {
    findings.push({
      code: 'xmlns-removed',
      severity: 'error',
      message: 'root xmlns removed — the file no longer renders standalone',
      detail: `xmlns was "${before.root.xmlns}"`,
    });
  }
  if (before.root.viewBox && !after.root.viewBox) {
    findings.push({
      code: 'viewBox-removed',
      severity: 'error',
      message: 'viewBox removed — scaling now depends on the embedding context',
      detail: `viewBox was "${before.root.viewBox}"`,
    });
  } else if (before.root.viewBox && after.root.viewBox !== before.root.viewBox) {
    // Numeric comparison, not string comparison: cleanupNumericValues rounds
    // 2195.656274 -> 2195.656, which moves nothing anyone can see. Tolerance is
    // 0.2% of the box's longest edge.
    const delta = viewBoxDelta(before.root.viewBox, after.root.viewBox);
    if (delta === null) {
      findings.push({
        code: 'viewBox-changed',
        severity: 'error',
        message: 'viewBox changed — the coordinate system moved',
        detail: `${before.root.viewBox} -> ${after.root.viewBox}`,
      });
    } else if (delta > 0.002) {
      findings.push({
        code: 'viewBox-changed',
        severity: 'error',
        message: `viewBox moved by ${(delta * 100).toFixed(2)}% of its longest edge`,
        detail: `${before.root.viewBox} -> ${after.root.viewBox}`,
      });
    } else if (delta > 0) {
      findings.push({
        code: 'viewBox-rounded',
        severity: 'info',
        message: `viewBox rounded by ${(delta * 100).toFixed(3)}% of its longest edge`,
        detail: `${before.root.viewBox} -> ${after.root.viewBox}`,
      });
    }
  }
  if (before.root.preserveAspectRatio && !after.root.preserveAspectRatio) {
    findings.push({
      code: 'preserveAspectRatio-removed',
      severity: 'warn',
      message: 'preserveAspectRatio removed — non-default fitting is lost',
      detail: `was "${before.root.preserveAspectRatio}"`,
    });
  }
  if (
    (before.root.width && !after.root.width) ||
    (before.root.height && !after.root.height)
  ) {
    findings.push({
      code: 'intrinsic-size-removed',
      severity: 'warn',
      message: 'width/height removed — intrinsic size is now derived from viewBox',
      detail: `${before.root.width ?? '-'}x${before.root.height ?? '-'} -> ${after.root.width ?? '-'}x${after.root.height ?? '-'}`,
    });
  }

  // Reference integrity is a property of the *result*, not of name stability:
  // cleanupIds renames ids and rewrites the references that point at them, which
  // is correct. Only a reference that resolves to nothing is a defect.
  const afterIds = new Set(after.ids);
  /** @type {Map<string, Ref & {element: string}>} */
  const dangling = new Map();
  for (const ref of after.refs) {
    if (!afterIds.has(ref.id)) {
      const key = `${ref.id}\u0000${ref.syntax}`;
      if (!dangling.has(key)) dangling.set(key, ref);
    }
  }
  const renamed = before.ids.filter((id) => !afterIds.has(id));
  if (renamed.length > 0 && dangling.size === 0) {
    findings.push({
      code: 'ids-renamed',
      severity: 'info',
      message: `${renamed.length} id(s) renamed, all internal references still resolve`,
      detail: `${renamed.slice(0, 4).map((id) => `#${id}`).join(', ')} — external selectors that used these ids will break`,
    });
  }

  // A stylesheet selector is a reference nothing else guarantees: if `#mark{}`
  // survives but no element carries that id any more, the rule is dead paint.
  // url()/href references are different — inlining a colour legitimately removes
  // them — so only selector references are checked for disappearance.
  const afterSelectors = new Set(
    after.refs.filter((ref) => ref.syntax === 'css selector').map((ref) => ref.id),
  );
  const deadSelectors = before.refs
    .filter((ref) => ref.syntax === 'css selector')
    .filter((ref) => !afterIds.has(ref.id) && !afterSelectors.has(ref.id))
    .map((ref) => ref.id);
  if (deadSelectors.length > 0) {
    findings.push({
      code: 'style-selector-lost',
      severity: 'error',
      message: `${deadSelectors.length} stylesheet selector(s) no longer match any element`,
      detail: deadSelectors.slice(0, 4).map((id) => `#${id}`).join(', '),
    });
  }
  if (dangling.size > 0) {
    const list = [...dangling.values()];
    findings.push({
      code: 'dangling-reference',
      severity: 'error',
      message: `${list.length} reference(s) point at ids that no longer exist`,
      detail: list
        .slice(0, 6)
        .map((ref) => `#${ref.id} via ${ref.syntax} on <${ref.element}>`)
        .join('; '),
    });
  }

  if (before.hasScript && !after.hasScript) {
    findings.push({
      code: 'script-removed',
      severity: 'error',
      message: '<script> removed — interactive behaviour is gone',
    });
  }
  if (before.eventAttrs > after.eventAttrs) {
    findings.push({
      code: 'event-handlers-removed',
      severity: 'error',
      message: `${before.eventAttrs - after.eventAttrs} event handler attribute(s) removed`,
      detail: `on* attributes: ${before.eventAttrs} -> ${after.eventAttrs}`,
    });
  }
  if (before.animationCount > after.animationCount) {
    findings.push({
      code: 'animation-removed',
      severity: 'error',
      message: `${before.animationCount - after.animationCount} animation element(s) removed`,
      detail: `SMIL elements: ${before.animationCount} -> ${after.animationCount}`,
    });
  }
  const foreignBefore = before.counts.foreignObject ?? 0;
  const foreignAfter = after.counts.foreignObject ?? 0;
  if (foreignAfter < foreignBefore) {
    findings.push({
      code: 'foreignObject-removed',
      severity: 'error',
      message: `${foreignBefore - foreignAfter} <foreignObject> element(s) removed`,
    });
  }
  const textBefore = before.counts.text ?? 0;
  const textAfter = after.counts.text ?? 0;
  if (textAfter < textBefore) {
    findings.push({
      code: 'text-element-removed',
      severity: 'error',
      message: `${textBefore - textAfter} <text> element(s) removed — text is no longer selectable`,
    });
  }
  const imageBefore = before.counts.image ?? 0;
  const imageAfter = after.counts.image ?? 0;
  if (imageAfter < imageBefore) {
    findings.push({
      code: 'image-removed',
      severity: 'error',
      message: `${imageBefore - imageAfter} <image> element(s) removed`,
    });
  }
  if (before.externalHrefs > after.externalHrefs) {
    findings.push({
      code: 'external-resource-removed',
      severity: 'error',
      message: `${before.externalHrefs - after.externalHrefs} external/data resource reference(s) removed`,
    });
  }

  if (before.textContent !== after.textContent && before.counts.text) {
    findings.push({
      code: 'text-content-changed',
      severity: 'warn',
      message: 'text content changed — the label a reader sees is different',
      detail: `${before.textContent.slice(0, 60)} -> ${after.textContent.slice(0, 60)}`,
    });
  }

  if (before.styleText !== null) {
    const normalizedBefore = normalizeCss(before.styleText);
    const normalizedAfter = normalizeCss(after.styleText ?? '');
    if (normalizedBefore !== normalizedAfter) {
      findings.push({
        code: 'style-rewritten',
        severity: 'warn',
        message: '<style> content rewritten — verify selectors still resolve',
        detail: `${normalizedBefore.length}B -> ${normalizedAfter.length}B of CSS`,
      });
    }
  }

  const titleBefore = before.counts.title ?? 0;
  const descBefore = before.counts.desc ?? 0;
  const titleAfter = after.counts.title ?? 0;
  const descAfter = after.counts.desc ?? 0;
  if (titleAfter < titleBefore || descAfter < descBefore) {
    findings.push({
      code: 'accessibility-text-removed',
      severity: 'warn',
      message: '<title>/<desc> removed — assistive text for the graphic is gone',
      detail: `title ${titleBefore}->${titleAfter}, desc ${descBefore}->${descAfter}`,
    });
  }

  if (after.drawableCount < before.drawableCount) {
    findings.push({
      code: 'drawable-count-dropped',
      severity: 'info',
      message: `${before.drawableCount - after.drawableCount} drawable element(s) folded away (mergePaths and shape conversion do this legitimately)`,
      detail: `${before.drawableCount} -> ${after.drawableCount}`,
    });
  }

  return findings;
}

/**
 * Relative movement between two viewBoxes, or null when they are not comparable
 * (different shape, unparsable numbers).
 * @param {string} before
 * @param {string} after
 * @returns {number | null}
 */
export function viewBoxDelta(before, after) {
  const parse = (value) =>
    value
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const a = parse(before);
  const b = parse(after);
  if (a.length !== 4 || b.length !== 4) return null;
  const scale = Math.max(Math.abs(a[2]), Math.abs(a[3]), 1e-9);
  let worst = 0;
  for (let i = 0; i < 4; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst / scale;
}

/**
 * Compare CSS ignoring formatting only. minifyStyles legitimately reflows, so a
 * pure whitespace difference must not read as a semantic change.
 * @param {string} css
 * @returns {string}
 */
function normalizeCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .trim();
}

/**
 * @typedef {{id: string, attr: string, element: string, syntax: string}} Ref
 * @typedef {{code: string, severity: 'error' | 'warn' | 'info', message: string, detail?: string}} Finding
 * @typedef {{
 *   root: {name: string, viewBox: string | null, width: string | null, height: string | null, preserveAspectRatio: string | null, xmlns: string | null},
 *   counts: Record<string, number>,
 *   ids: string[],
 *   refs: Ref[],
 *   eventAttrs: number,
 *   styleText: string | null,
 *   externalHrefs: number,
 *   hasScript: boolean,
 *   animationCount: number,
 *   drawableCount: number,
 *   textContent: string
 * }} Snapshot
 */
