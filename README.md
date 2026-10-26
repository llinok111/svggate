# svggate

A render-verified gate for SVG optimization. Run it before you ship an optimiser
config, and it tells you **which svgo plugin changed what people see** — in
pixels and in structure — instead of handing you a boolean and hoping.

```
$ svggate check logo.svg
## logo.svg — BROKEN

input 313B (100x100 intrinsic, viewBox mapped to 437x437, 2 drawable, 1 ids) → artifact 180B

| # | plugin | bytes | delta | state | evidence |
|---|---|---|---|---|---|
| 1 | `removeDoctype` | 313 | ok | ok | — |
| … | | | | | |
| 15 | `removeUnknownsAndDefaults` | 199 | FAIL | FAIL | paint drifted: p99 channel delta 178/255 across 85.5% of painted blocks |
| 16 | `removeNonInheritableGroupAttrs` | 199 | ok | FAIL | — |
| … | | | | | |
| 34 | `removeDesc` | 180 | ok | FAIL | — |

### Attributed
- `removeUnknownsAndDefaults` (broken)
  - paint drifted: p99 channel delta 178/255 across 85.5% of painted blocks at 437px wide

Artifact verdict: **broken** (pixels: broken)
```

The two verdict columns are the point. `delta` answers *did this plugin move the
picture*; `state` answers *is the file wrong right now*. Collapse them into one
column and attribution becomes useless: after the plugin that broke the file,
every later plugin has a bad state and a clean delta.

## Why this exists

`svgo` is excellent at what it does, and its maintainers know the risks: the
project ships a visual regression suite (`test/regression/`, Playwright +
pixelmatch) that renders its own fixtures before and after optimisation. That
suite is for **svgo's** files, run by **svgo's** maintainers, on **svgo's**
machine. Users get no equivalent:

- `test/regression/compare-worker.js` rejects any pair whose dimensions differ
  (`throw new Error('Image dimensions do not match')`) and counts a difference of
  more than 3–4 pixels as a failure — a threshold calibrated for crisp fixture
  icons, unusable on a real asset with antialiasing.
- The technique (issue [#1656](https://github.com/svg/svgo/issues/1656),
  "Consider running tests with resvg-js", open since 2022) never reached the CLI.
- The failure reports keep arriving: [#1422](https://github.com/svg/svgo/issues/1422)
  "mergePaths plugin produces broken images", [#1746](https://github.com/svg/svgo/issues/1746)
  "Unique id is broken since v3", [#2104](https://github.com/svg/svgo/issues/2104)
  "Arc command optimization causes a circle to disappear", [#2239](https://github.com/svg/svgo/issues/2239)
  "removeUnknownsAndDefaults drops default values that block inheritance into
  `<use>`", [#2300](https://github.com/svg/svgo/issues/2300)
  "fix(cleanupIds): preserve ARIA ID references" — all open against 4.x.

svggate runs that idea on *your* assets, attributes the change to a named plugin,
and separates the two kinds of failure that need different checks:

| failure | how it is found | can pixels see it? |
|---|---|---|
| paint changed (opacity, fill, geometry) | rasterise both, compare | yes |
| an element disappeared | ink delta + 32×32 region maxima | usually |
| an id reference dangles | reference graph over the xast | no |
| `<script>`, SMIL, `<foreignObject>` gone | element census | no |
| accessible name broken (`aria-labelledby`) | reference graph | no |
| `viewBox` / intrinsic size changed | attribute comparison + numeric viewBox delta | no (layout depends on the host page) |

## Install

```bash
npm install          # runtime deps: svgo, @resvg/resvg-js, pngjs
node bin/svggate.mjs --help
```

Requires Node 18 or newer. `@resvg/resvg-js` ships prebuilt binaries for
Windows, macOS and Linux; no browser, no Playwright, no font setup.

## Use

```bash
# verify the default preset against one file
svggate check logo.svg

# whole directories, machine-readable output, diff images for every finding
svggate check assets/ --json report.json --md report.md --diff-dir diffs/

# produce an artifact with the offending plugins removed, and prove it is safe
svggate check logo.svg --strategy drop --out build/

# CI: fail on warnings too
svggate check assets/ --fail-on review
```

| option | default | meaning |
|---|---|---|
| `--strategy` | `report` | `report` verifies the full preset and ships nothing; `drop` removes offending plugins until the artifact renders like the original; `none` attributes only |
| `--plugins` | `preset-default` | comma-separated plugin names to replay |
| `--scales` | `1` | multipliers on the planned render size (the plan already maps the viewBox to ≤1536px) |
| `--fail-on` | `broken` | exit 1 at this level or worse |
| `--system-fonts` | off | load system fonts to rasterise `<text>` (see limitations) |
| `--multipass` | off | multipass for the artifact svgo is asked to produce |

Exit codes: `0` clean, `1` finding at or above `--fail-on`, `2` usage/IO/render
error. A render error is never swallowed into a pass.

## API

```js
import { gate } from 'svggate';

const report = gate(svgString, {
  strategy: 'drop',       // 'report' | 'drop' | 'none'
  scales: [1],
  thresholds: {},         // override any DEFAULT_THRESHOLDS entry
});

report.verdict;            // 'ok' | 'review' | 'broken'
report.blamed;             // [{ plugin, verdict, bytesSaved, reasons }]
report.steps;              // per-plugin delta + cumulative metrics
report.artifact?.svg;      // the artifact, when one was produced
```

`compareFrames`, `inkMask`, `dilate`, `snapshot`, `diffSnapshots`, `planSize` and
`PRESET_DEFAULT` are exported too, for callers that want the pieces.

## How a decision is made

Per plugin step, two independent passes:

**Structure** (xast, via svgo's own parser — no second XML implementation to
disagree with). Error class: dangling reference (including `url(#id)`, `href`,
SMIL `id.event`, ARIA id lists and CSS `#id` selectors), dead stylesheet
selector, removed `xmlns`/`viewBox`, `viewBox` moved by more than 0.2% of its
longest edge, removed `<script>` / event handlers / SMIL / `<foreignObject>` /
`<text>` / `<image>` / external reference. Warning class: intrinsic size
removed, `preserveAspectRatio` removed, `<style>` rewritten, `<title>`/`<desc>`
removed, text content changed. Informational: ids renamed with references kept,
`viewBox` rounding, drawable count reduced (`mergePaths` does this legitimately).

**Pixels** (resvg, deterministic, no browser). The viewBox is mapped to a fixed
≤1536px budget so a 2-unit feature is ~17px wide no matter how large the artboard
is — rendering at a fixed `width` instead was the first implementation and it hid
the very bug that motivated the tool (see `src/render.mjs`). Four signals:

1. **lost / gained ink** — full resolution, 1px dilation tolerance. A pixel only
   counts as lost if the other frame has no ink next to it, so a sub-pixel edge
   shift is free and a vanished shape is not.
2. **colour drift** — 4×4 blocks, *flattened over white* (so an opacity change is
   a brightness change, the way a viewer sees it), restricted to flat blocks: a
   colour statistic that includes silhouette edges reports 30–180 levels of
   difference for a 0.4px shift, which turned every optimisation into a false
   positive.
3. **region maxima** — 32×32 grid over "strong" changes (channel delta > 48).
   A 2-unit dot that vanishes inside a large green rectangle is 0.2% of the ink
   and invisible to every global ratio; it is not invisible to the region it used
   to occupy.
4. **size match** — any dimension change is a hard failure, never a ratio.

A step is `broken` if structure says error, or any pixel rule trips; `review` if
only a warning class or a sub-threshold pixel change fired; `ok` otherwise. The
artifact is then verified again on its own, because the artifact is what ships.

## How the thresholds were measured

Not chosen for looks. Two experiments, both reproducible with the shipped code.

**A. Documented real regressions must be caught.** The two minimal reproductions
in `test/fixtures/` are taken from upstream issues:

| fixture | upstream issue | svggate verdict | attributed to | evidence |
|---|---|---|---|---|
| `use-inheritance.svg` | [#2239](https://github.com/svg/svgo/issues/2239) | broken | `removeUnknownsAndDefaults` | paint drift, p99 Δ178/255 over 85.5% of painted blocks |
| `arc-dot.svg` | [#2104](https://github.com/svg/svgo/issues/2104) | broken | `convertPathData` | localised change, 176px lost = 26% of one 32×32 region |

`aria-labelledby.svg` reproduces a third defect the tool found on its own and
which upstream later confirmed as
[#2300](https://github.com/svg/svgo/issues/2300): `cleanupIds` strips
`<title id="t">` and leaves `aria-labelledby="t"` pointing at nothing. Pixels are
identical — `report.artifact.pixels === 'ok'` — which is exactly why the gate runs
a structural pass.

**B. Benign optimisations must not be caught.** `test/corpus/` holds 28 real
third-party SVGs (iconmonstr icons, Keyv/css-tree logos, project banners) that
were already on disk. Running the full default preset over them with the shipped
thresholds:

- 28 files, default preset replayed plugin by plugin: **13 ok, 15 review,
 0 broken.**
- Zero false failures. Every one of the 15 reviews is attributable to a real,
  named transformation: `inlineStyles` rewritten CSS on 13 files, and
  `removeUnknownsAndDefaults` stripping `width="100%" height="100%"` on 2 banners
  (a genuine layout risk, reported as a warning with the reason).
- Wall clock: ~4s per file (34 plugin steps × ~3 rasterisations each), no browser
  involved.

Both numbers matter. Catch rate alone is easy to fake; it is the false-positive
rate that decides whether a tool like this is usable in a pipeline.

## Limits, stated plainly

- **Text glyphs are not compared by default.** Loading system fonts costs
  ~131ms *per render* (measured), versus 0.1ms without, so fonts are off unless
  you pass `--system-fonts`. With fonts off, a `<text>` element rasterises to
  nothing and glyph-level changes are invisible to the pixel pass; structure
  still catches removed text and changed text content. Pass `--system-fonts` for
  text-heavy assets.
- **SMIL timing is not simulated.** Removed animation elements are an error, but
  a change that only shows up at t=1.5s is not measured. The gate compares the
  t=0 frame.
- **CSS from outside the document is invisible.** Only `<style>` inside the file
  is parsed; a class defined by the host page is nobody's business here.
- **External references cannot be resolved.** `href="https://…"` is reported as
  removed or present, never fetched.
- Cross-machine byte equality is not promised for text-bearing files; both frames
  of a comparison always come from the same machine and the same renderer.
- The gate measures *rendering equivalence*, not *correctness*. An SVG that was
  already wrong renders wrong identically and passes — that is the contract.

## Relationship to svgo

svggate does not fork svgo and does not patch it. It imports the published
package, mirrors the plugin order of `preset-default` as a plain list (svgo's
`exports` map exposes only the package root), and proves that mirror stays
equivalent by comparing the stepped result against a real `preset-default` run on
every fixture — `test/gate.test.mjs`, first test. Upgrading svgo is a dependency
bump; if the order drifts, the test fails before a user sees a wrong verdict.

## Tests

```bash
npm test
```

37 tests across five files (comparator maths on synthetic frames, structural
checks, gate integration on real svgo + resvg, CLI exit codes, packaging
guards). The suite spawns one Node process per file via `scripts/test.mjs`
instead of `node --test <dir>`, because declared support starts at Node 18 and
directory/glob handling differs across Node majors and platforms.

## License

MIT (see `LICENSE`). Upstream attribution and the licence of every dependency
are in `NOTICE`. svggate copies no upstream source: svgo and resvg are runtime
dependencies.
