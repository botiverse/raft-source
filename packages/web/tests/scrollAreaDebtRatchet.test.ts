/**
 * Required-Test Admission evidence (docs/sops/ci-check-maintenance.md)
 *
 * - Test/check: packages/web ScrollArea debt ratchet
 *   (scripts/check-scroll-area-debt.ts, chained into `lint`)
 * - Adjudicated decision: task #proj-raft-ui:#209 (ScrollArea everywhere):
 *   raft-ui's `raft-ui/prefer-scroll-area` holds new code to it, the native
 *   scrollers that predate it are a list that can only shrink.
 * - RED proof (minimal production mutation): add
 *   `// oxlint-disable-next-line raft-ui/prefer-scroll-area` above a new
 *   `<div className="overflow-y-auto">` in src/App.tsx → "src/App.tsx: 3
 *   suppressed native scroller(s), baseline 2"; restored file → OK.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { recommendedRules } from "@botiverse/raft-ui/lint";
import {
  NATIVE_SCROLL_RE,
  checkConfig,
  checkLintScript,
  findGrowth,
  findStale,
  parseOxlintConfig,
  resolveOxlintConfig,
  scanSource,
} from "../scripts/check-scroll-area-debt";
import type { ReadConfig } from "../scripts/check-scroll-area-debt";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(WEB_ROOT, ".oxlintrc.json");
const CONFIG = readFileSync(CONFIG_PATH, "utf8");
/** A config path for configs given inline, and a reader that finds no other file. */
const APP_DIR = "/app";
const APP = resolve(APP_DIR, ".oxlintrc.json");
const readNone: ReadConfig = () => null;
const DEBT = "// oxlint-disable-next-line raft-ui/prefer-scroll-area -- ScrollArea migration debt";

test("a suppression above a native scroller counts as debt", () => {
  const scan = scanSource(
    "src/A.tsx",
    `const a = (
  <div>
    ${DEBT}
    <div className="flex-1 overflow-y-auto" />
    {/* oxlint-disable-next-line raft-ui/prefer-scroll-area -- debt */}
    <pre className="md:overflow-x-scroll" />
    <p
      ${DEBT}
      style={{ overflowY: "auto" }}
    />
  </div>
);`,
  );
  assert.deepEqual({ count: scan.count, problems: scan.problems }, { count: 3, problems: [] });
});

test("an exception is not debt, and is listed with its reason", () => {
  const scan = scanSource(
    "src/A.tsx",
    `const a = (
  <pre
    // raft-ui: native-scroll a <pre> holds phrasing content only
    className="overflow-x-auto"
  />
);`,
  );
  assert.equal(scan.count, 0);
  assert.deepEqual(scan.problems, []);
  assert.deepEqual(scan.exceptions, [{ where: "src/A.tsx:3", reason: "a <pre> holds phrasing content only" }]);
});

test("a directive in a string or in JSX text is not a comment", () => {
  const scan = scanSource(
    "src/A.tsx",
    `const s = "// oxlint-disable-next-line";
const a = <p>see https://example.com // oxlint-disable</p>;`,
  );
  assert.deepEqual(scan.problems, []);
});

test("the style pattern reads quoted keys and conditional values", () => {
  for (const line of [
    `style={{ overflowY: "auto" }}`,
    `style={{ "overflowY": "auto" }}`,
    `style={{ 'overflow': 'scroll' }}`,
    `style={{ overflowY: open ? "auto" : "hidden" }}`,
    `style={{ overflowX: wide && "scroll" }}`,
    `className="md:overflow-y-auto"`,
    `className="[overflow-y:auto]"`,
  ]) {
    assert.match(line, NATIVE_SCROLL_RE, line);
  }
  for (const line of [`style={{ overflowY: "hidden" }}`, `style={{ overflowX: "hidden", height: "auto" }}`, `className="overflow-hidden"`, `className="overflow-y-autoish"`]) {
    assert.doesNotMatch(line, NATIVE_SCROLL_RE, line);
  }
});

test("a suppression left behind after a migration fails", () => {
  const scan = scanSource("src/A.tsx", `${DEBT}\nconst a = <ScrollArea className="flex-1" />;`);
  assert.equal(scan.count, 0);
  assert.match(scan.problems.join("\n"), /src\/A\.tsx:1: .*no longer sits above a native scroller/);
});

test("block, same-line, multi-line, aliased and bare disables can't hide the rule", () => {
  const block = scanSource("src/A.tsx", "/* oxlint-disable raft-ui/prefer-scroll-area */\nconst a = <div className=\"overflow-auto\" />;");
  assert.match(block.problems.join("\n"), /one line at a time/);
  const multiLine = scanSource("src/A.tsx", "/* eslint-disable\n   react/jsx-key,\n   raft-ui/prefer-scroll-area */\nconst a = <div className=\"overflow-auto\" />;");
  assert.match(multiLine.problems.join("\n"), /one line at a time/);
  const sameLine = scanSource("src/A.tsx", "const a = <div className=\"overflow-auto\" />; // eslint-disable-line raft-ui/prefer-scroll-area");
  assert.match(sameLine.problems.join("\n"), /one line at a time/);
  const aliased = scanSource("src/A.tsx", "/* oxlint-disable @botiverse/raft-ui/prefer-scroll-area */\nconst a = 1;");
  assert.match(aliased.problems.join("\n"), /one line at a time/);
  for (const bare of ["// oxlint-disable-next-line\nconst a = 1;", "/* oxlint-disable */\nconst a = 1;", "const a = 1; // eslint-disable-line -- why"]) {
    assert.match(scanSource("src/A.tsx", bare).problems.join("\n"), /names no rule/, bare);
  }
  // A disable of other rules above a scroller doesn't hide this one, so it's fine.
  const other = scanSource("src/A.tsx", "// oxlint-disable-next-line react/jsx-key\nconst a = <div className=\"overflow-auto\" />;");
  assert.deepEqual({ count: other.count, problems: other.problems }, { count: 0, problems: [] });
});

test("more debt than the baseline fails, and less must lower the baseline", () => {
  assert.deepEqual(findGrowth({ "src/A.tsx": 2 }, { "src/A.tsx": 2 }), []);
  assert.match(findGrowth({ "src/A.tsx": 3 }, { "src/A.tsx": 2 }).join("\n"), /src\/A\.tsx: 3 .* baseline 2/);
  assert.match(findGrowth({ "src/New.tsx": 1 }, {}).join("\n"), /src\/New\.tsx: 1 .* baseline 0/);
  assert.match(findStale({ "src/A.tsx": 1 }, { "src/A.tsx": 2 }).join("\n"), /down to 1 from 2/);
  assert.match(findStale({}, { "src/Gone.tsx": 1 }).join("\n"), /down to 0 from 1/);
});

test("the rule stays on as an error in the app's Oxlint config", () => {
  assert.deepEqual(checkConfig(CONFIG, CONFIG_PATH), []);
  // Set in the app's own config, as before `extends`.
  const set = (value: string) => `{ "jsPlugins": ["@botiverse/raft-ui/lint"], "rules": { "raft-ui/prefer-scroll-area": ${value} } }`;
  assert.deepEqual(checkConfig(set(`"error"`), APP, readNone), []);
  assert.deepEqual(checkConfig(set(`["error"]`), APP, readNone), []);
  assert.match(checkConfig(set(`"warn"`), APP, readNone).join(), /must be "error"/);
  // A commented-out setting is not a setting.
  assert.match(checkConfig(`{ "jsPlugins": ["@botiverse/raft-ui/lint"], "rules": { // "raft-ui/prefer-scroll-area": "error"\n } }`, APP, readNone).join(), /must be "error"/);
  assert.match(checkConfig(`{ "rules": { "raft-ui/prefer-scroll-area": "error" } }`, APP, readNone).join(), /neither it nor/);
  const override = `{ "jsPlugins": ["@botiverse/raft-ui/lint"], "rules": { "raft-ui/prefer-scroll-area": "error" }, "overrides": [{ "files": ["src/x/**"], "rules": { "raft-ui/prefer-scroll-area": "off" } }] }`;
  assert.match(checkConfig(override, APP, readNone).join(), /overrides\[0\]\.rules: raft-ui\/prefer-scroll-area must stay "error"/);
});

test("the rule can be on through extends, but extends can't turn it down", () => {
  const RECOMMENDED = `{ "plugins": [], "jsPlugins": ["@botiverse/raft-ui/lint"], "rules": { "raft-ui/prefer-scroll-area": "error" } }`;
  const files = (extra: Record<string, string> = {}): ReadConfig => (path) =>
    ({ [resolve(APP_DIR, "rec.json")]: RECOMMENDED, ...extra })[path] ?? null;
  const app = (body = "") => `{ "extends": ["./rec.json"]${body} }`;
  assert.deepEqual(checkConfig(app(), APP, files()), []);
  // The app's own rules win over what it extends.
  assert.match(checkConfig(app(`, "rules": { "raft-ui/prefer-scroll-area": "warn" }`), APP, files()).join(), /must be "error"/);
  assert.match(checkConfig(app(`, "rules": { "@botiverse/raft-ui/prefer-scroll-area": "off" }`), APP, files()).join(), /must stay "error"/);
  assert.match(checkConfig(app(`, "overrides": [{ "files": ["src/**"], "rules": { "raft-ui/prefer-scroll-area": 1 } }]`), APP, files()).join(), /overrides\[0\]\.rules: .* must stay "error"/);
  // A later extends wins over an earlier one.
  const off = { [resolve(APP_DIR, "off.json")]: `{ "rules": { "raft-ui/prefer-scroll-area": "off" } }` };
  assert.match(checkConfig(`{ "extends": ["./rec.json", "./off.json"] }`, APP, files(off)).join(), /must be "error" once its extends/);
  // An extended config's overrides count too.
  const recOverride = { [resolve(APP_DIR, "rec.json")]: RECOMMENDED.replace(/ }$/, `, "overrides": [{ "files": ["**"], "rules": { "raft-ui/prefer-scroll-area": "off" } }] }`) };
  assert.match(checkConfig(app(), APP, files(recOverride)).join(), /extends \.\/rec\.json overrides\[0\]\.rules: .* must stay "error"/);
  // Nested extends resolve relative to the config that names them.
  const nested = { [resolve(APP_DIR, "a/outer.json")]: `{ "extends": ["../rec.json"] }` };
  assert.deepEqual(checkConfig(`{ "extends": ["./a/outer.json"] }`, APP, files(nested)), []);
  // A missing, unreadable, cyclic, or commented-out extends doesn't count.
  assert.match(checkConfig(`{ "extends": ["./missing.json"] }`, APP, files()).join(), /can't be read/);
  assert.match(checkConfig(app(), APP, files({ [resolve(APP_DIR, "rec.json")]: "[" })).join(), /can't be read as JSONC/);
  assert.match(checkConfig(`{ "extends": ["./.oxlintrc.json"] }`, APP, files()).join(), /extends itself/);
  const commented = checkConfig(`{ // "extends": ["./rec.json"]\n }`, APP, files());
  assert.match(commented.join(), /must be "error"/);
  assert.match(commented.join(), /neither it nor/);
  // A plugin an override loads doesn't load it for the whole config.
  assert.match(
    checkConfig(`{ "rules": { "raft-ui/prefer-scroll-area": "error" }, "overrides": [{ "files": ["src/a/**"], "jsPlugins": ["@botiverse/raft-ui/lint"] }] }`, APP, readNone).join(),
    /neither it nor/,
  );
  // A cycle the path check can't see (a symlink) stops by depth.
  const deep: ReadConfig = (path) => (path.startsWith(APP_DIR) ? `{ "extends": ["./x/.oxlintrc.json"] }` : null);
  assert.match(checkConfig(`{ "extends": ["./x/.oxlintrc.json"] }`, APP, deep).join(), /nest deeper/);
  // Without the plugin, the rule being "error" does nothing.
  const noPlugin = { [resolve(APP_DIR, "rec.json")]: `{ "rules": { "raft-ui/prefer-scroll-area": "error" } }` };
  assert.match(checkConfig(app(), APP, files(noPlugin)).join(), /neither it nor/);
});

test("the app extends raft-ui's installed recommended config", () => {
  // The file the package exports as its recommended config, wherever it lives.
  const recommended = realpathSync(createRequire(CONFIG_PATH).resolve("@botiverse/raft-ui/lint/recommended.json"));
  const extended = (parseOxlintConfig(CONFIG)?.extends ?? []).map((spec) => {
    const path = resolve(WEB_ROOT, String(spec));
    return existsSync(path) ? realpathSync(path) : path;
  });
  assert.ok(extended.includes(recommended), `.oxlintrc.json extends ${JSON.stringify(extended)}, not ${recommended}`);
});

test("every rule in raft-ui's recommended config is an error here", () => {
  const { rules } = resolveOxlintConfig(CONFIG, CONFIG_PATH);
  for (const [rule, level] of Object.entries(recommendedRules)) {
    // A rule the recommended config ships "off" (raft-ui/no-raw-z-index since
    // 0.85.0) is opt-in: an app turns it on in its own config when it is ready.
    if (level === "off") continue;
    assert.equal(level, "error", `${rule} in raft-ui's recommended config`);
    assert.equal(rules[rule], "error", `${rule} is not "error" in .oxlintrc.json with its extends applied; turn on what raft-ui's recommended config lists`);
  }
});

test("the web turns on raft-ui/no-raw-z-index as an error", () => {
  // raft-ui ships it off in its recommended config (opt-in); the web opted in
  // with the named layers (#proj-raft-ui:#218), so it must stay an error here.
  const { rules } = resolveOxlintConfig(CONFIG, CONFIG_PATH);
  assert.equal(rules["raft-ui/no-raw-z-index"], "error");
});

test("the lint script can't allow or warn the rule away", () => {
  const lint = (JSON.parse(readFileSync(resolve(WEB_ROOT, "package.json"), "utf8")) as { scripts: { lint: string } }).scripts.lint;
  assert.deepEqual(checkLintScript(lint), []);
  assert.match(checkLintScript("oxlint -A raft-ui/prefer-scroll-area src").join(), /turns/);
  assert.match(checkLintScript("oxlint --allow=all src").join(), /turns/);
  assert.deepEqual(checkLintScript("oxlint -A react/jsx-key src"), []);
});
