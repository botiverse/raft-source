# Spec: provider-pair-first comparison model (task #430)

Status: draft for review · Owner: CC-Wow2 · Data-model review: Settings API Steward · Decided by artin 2026-07-09 ("从顶层考虑" → "可以，推进吧，先写spec")

## Problem

The site and CLI grew from a two-provider design (react baseline vs android
current). iOS was added as an "extras" appendage: extra tabs suffixed `· iOS`,
secondary detail pages, per-case `comparisons[]` hanging off a privileged
primary pair. The asymmetry leaks everywhere and each leak has surfaced as a
user-facing bug within one day of iOS going live:

- overview grid and summary tiles silently stayed on `react__android` while an
  iOS tab looked selected (#4276/#4280 patched the visible cases);
- opening a case from an iOS overview landed on the android tab (#4280);
- `baseline`/`current` naming semantically hard-codes "current = android";
- iOS vs android (no react in the middle) is impossible to express;
- every new provider (OHOS next) would re-inherit all of the above.

Patching per-symptom does not converge. The model must change.

## Goals

1. **Pairs are first-class and arbitrary.** A comparison pair is any ordered
   `(leftProvider, rightProvider)`. Three pair classes, all built by the same
   machinery:
   - baseline pairs: `react__android`, `react__ios`, `react__ohos` — "how far
     is each platform from the react reference";
   - cross-platform pairs: `android__ios`, `android__ohos`, `ios__ohos` —
     "are the mobile ends isomorphic" (no react in the middle);
   - the full matrix view across all providers (see Goal 4).
2. **One global selection.** The whole site derives from a single
   `selectedComparisonKey` (e.g. `react__ios`): overview tiles, waterfall grid,
   case-detail default tab, AI panel, metrics addon. Switching the pair
   switches *everything*; entering a case never falls back to another pair.
3. **Shareable state.** URLs carry the pair — overview `?comparison=react__ios`
   and case `#case/<id>?comparison=react__ios`. Refresh, copy-link, and
   browser back/forward preserve it.
4. **Matrix view.** An alternate overview mode: rows = cases, columns =
   providers; each cell shows status color + thumbnail. Clicking two providers
   (or a per-row pair shortcut) jumps into that pair's diff for that case.
   Data source is the same pair index — no separately computed platform state.
5. **Provider visual identity.** Each provider gets a fixed accent used on
   tabs, status dots, and image corner badges: react = ink/black, android =
   green, iOS = blue, OHOS = orange. Any screen is identifiable at a glance.
6. **AI analysis knows the pair class.** Baseline-pair prompts keep the
   "react is the reference" framing; cross-platform prompts state that both
   sides are Kuikly ends and the question is isomorphism, not fidelity to a
   reference. `intentional`/platformDivergences injection (from #4280) applies
   to both, keyed by case.

## Non-goals

- No change to capture legs or image formats. Capture stays per-provider;
  pairs are assembled at diff time.
- No redesign of the per-run detail layer (`latest/index.html`,
  `react__ios.html`). Those pages remain as plain permalinks; the storybook
  shell is the primary UX. (They may later read the same pair index, but that
  is not part of this task.)
- No renaming of published artifact paths. `latest/diff/react__ios/...`
  stays; new cross-platform pairs add sibling directories
  (`latest/diff/android__ios/...`).

## Data model

### CLI internals

- `comparisonPairs()` today builds `[primary, ...extras]` from
  `--baseline react --current android,ios`. It becomes a flat list of pair
  objects built from **`--pairs`**:

  ```
  --pairs react__android,react__ios,android__ios
  ```

  Back-compat: `--baseline X --current a,b` is sugar for
  `--pairs X__a,X__b` and keeps working. Every pair object is
  `{ left, right, key, label, diffData, componentMatrix, detailHref }`; no
  pair is privileged. `diffPair`/`analyzePair`/metrics work on `(left, right)`
  instead of assuming `baseline=react`.
- `metadata.comparisons[]` is already per-pair; it becomes the only source —
  the top-level `baseline`/`current`/`summary` fields are kept as **compat
  mirrors of the first pair** during migration and marked deprecated.

### Pair identity and keys

- Pair identity is **unordered**; the canonical key orders ends by provider
  precedence `react > android > ios > ohos` (so `ios__android` canonicalizes
  to `android__ios`). This is an API contract: CLI input, URLs, cache keys,
  and artifact directories are all normalized to the canonical key —
  `?comparison=ios__android` is rewritten to `?comparison=android__ios` on
  load so history/localStorage/AI caches never fork.
- A pair entry always carries explicit ends and class — the key is an opaque
  stable id, never parsed for semantics (provider names may later contain
  separators or aliases):

  ```
  { key, leftProvider, rightProvider, label, class: "baseline"|"cross-platform" }
  ```

### Site payload (vt-data / home-cases.json)

- Today: per-case primary fields (`similarity`, `status`, images, `analysis`)
  plus `comparisons[]` for extras — a primary/extras split.
- Target: per-case **two sibling indexes** (raw provider captures are the
  explicit source data of pairs, not something reverse-engineered from them):

  ```
  providers: { [provider]: { status, image, metadata, capturedAt?, error? } }
  pairs:     { [pairKey]:  { leftProvider, rightProvider, status, similarity,
                             metrics, sideBySideImage, overlayImage, analysis } }
  ```

  The Matrix view reads `providers[*]` (a provider cell must reflect "capture
  exists" even when some pair diff failed); pair views (overview grid, tiles,
  case tabs, AI panel) read `pairs[*]`.
- The old primary fields and `comparisons[]` are emitted as **output-only
  compat mirrors** during migration. New home.js code reads only
  `providers`/`pairs` and falls back to legacy fields solely when opening an
  old published run — no new code path may treat `item.sideBySideImage`-style
  primary fields as current (that implicit-primary habit is exactly the leak
  this spec exists to close).

### URL schema

- Overview: `?comparison=<canonicalPairKey>` (query, so the server-rendered
  initial state can be steered later if we ever pre-render; hash stays for
  cases).
- Case: `#case/<caseId>?comparison=<canonicalPairKey>`.
- Non-canonical keys are normalized (see Pair identity); missing/unknown pair
  key falls back to the first pair, never errors.

## UI changes (storybook shell)

1. Global pair switcher in the toolbar (persistent, replaces the overview-only
   tab hack from #4276): segmented control listing pairs with provider accents
   (`React ↔ Android`, `React ↔ iOS`, `Android ↔ iOS`, …). The label always
   names both ends — never "Side-by-side · iOS" with an implicit android.
2. Case detail: four stable tabs — `<Left>`, `<Right>`, `Side-by-side`,
   `Overlay` — bound to the selected pair. The `· iOS`-suffixed tab families
   disappear. (Raw provider images are per-provider, so `<Left>`/`<Right>`
   tabs render whatever the pair selects.)
3. Summary tiles, waterfall, metrics addon, AI panel: all read the selected
   pair's entry (mechanics already proven by #4276/#4280; this unifies them
   behind one state instead of two code paths).
4. Matrix mode toggle on the overview: `Grid | Matrix`. Matrix rows are cases,
   columns providers (status dot + lazy thumbnail); a cell click opens the
   case with that provider's raw tab; a row's "diff" affordance opens the
   selected pair.
5. Provider accents as CSS custom properties (`--provider-react`,
   `--provider-android`, `--provider-ios`, `--provider-ohos`) applied to tabs,
   dots, and corner badges.

## AI analysis

- `analyzePair` prompt gains pair-class framing:
  - baseline pair: unchanged ("left is the react reference…");
  - cross-platform pair: "both sides are Kuikly-rendered mobile ends; report
    divergences between them; neither side is the reference".
- platformDivergences entries gain an explicit **`appliesTo`** scope —
  `baselineOnly` | `crossPlatform` | `allPairs` — and prompt injection filters
  by the pair's `class`. Existing entries default to: `react-adopts-later` →
  `baselineOnly` (by definition it describes distance from react),
  `platform-difference` → `allPairs`.
- Analysis output/caching is already per-pair (`analysis/<pairKey>.json`) —
  unchanged.

## Publish guards

- The per-pair "entire provider missing" guard (#4249) and case-count guards
  iterate `comparisons[]` already — they keep working with more pairs. The
  tolerance rule is two-sided and precise:
  - a provider whose capture leg is missing/failed marks every pair touching
    it as `missing/tolerated` and must not block publishing the other pairs
    (a missing OHOS leg never blocks react__android);
  - when BOTH ends' raw captures exist, the pair's diff/metrics/site entry
    MUST be produced — a pair-generation failure with both inputs present is
    a publish failure, never silently folded into "tolerated".

## Rollout

Three PRs, each shippable and verified against real gh-pages data + Playwright:

1. **PR-1 model + switcher**: CLI `--pairs` parsing (with `--current` sugar),
   uniform pair objects, site payload `pairs` index + compat mirrors, global
   pair switcher replacing the #4276 overview tabs, case tabs bound to pair,
   URL schema. Absorbs/retires the special-cased code from #4276/#4280.
2. **PR-2 matrix view**: overview Matrix mode reading the pair index.
3. **PR-3 cross-platform pairs end-to-end**: `android__ios` in the mobile
   workflow's publish invocation, AI pair-class prompts, guard tolerance
   rules, provider accents everywhere (accents may land earlier if trivial).

Acceptance (phone-first, artin's browsing patterns):

- switch to `React ↔ iOS`: tiles/grid/AI all follow; open a case → iOS pair
  tabs; copy URL → reopens in the same state;
- switch to `Android ↔ iOS`: side-by-side shows android left / iOS right with
  its own metrics and AI notes;
- Matrix: one row per case, a red iOS cell is visible at a glance where
  android is green;
- no regression on 390 px width; old run permalinks still open.

## Capability metadata (interface to the #429 renderer spec)

Renderers emit a one-line `SLOCK_RICHTEXT_CAPS {...}` marker (capability facts
only — e.g. `inlineCodeChrome`, `slockRefChrome`, `reactionAtlas`,
`declaredDivergences`; absent = unknown, never defaulted true). Capture folds
it into per-case metadata; the site surfaces it verbatim on the
`providers[*].metadata` side as "declared fallback / pending" badges with a
separate small count. Declared divergences are never auto-passed and never
deducted from the Different count — acceptance stays with case policy/review.
Field names are owned by the #429 spec; this site consumes them verbatim.

## Resolved review decisions

1. **Pair ordering** — see "Pair identity and keys": unordered identity,
   canonical key by provider precedence, normalization is an API contract.
2. **Cross-platform pairs default ON.** The regular publish default is
   `react__android,react__ios,android__ios`; `--pairs` remains the explicit
   override so a dispatch round can narrow to save artifacts or verify a
   single leg. (Settings API Steward, task #430 thread.)
3. **Tolerances are configured per `pair.class`** — `baseline` and
   `cross-platform` are two config slots that START with identical values;
   the sameness is a configuration choice, never hard-coded into the model.
   Cross-platform thresholds get revisited once android__ios data
   accumulates. (Settings API Steward, task #430 thread.)
