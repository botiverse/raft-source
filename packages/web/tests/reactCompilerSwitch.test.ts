import assert from "node:assert/strict";
import { transformAsync } from "@babel/core";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import {
  createReactCompilerRecorder,
  markReactCompilerHtml,
  reactCompilerEnabled,
  reactCompilerOptions,
  reactCompilerPlugins,
} from "../scripts/reactCompilerSwitch";

// React Compiler is a build-time switch that only the staging web build sets
// (scripts/reactCompilerSwitch.ts). Off must mean "no plugin at all": that is
// what keeps every other build the one it was.

const ROOT = "/repo/packages/web";

type NamedPlugin = { name: string };

async function pluginNames(environment: Record<string, string>): Promise<string[]> {
  const plugins = (await Promise.all(await reactCompilerPlugins(environment, ROOT))).flat() as NamedPlugin[];
  return plugins.map((plugin) => plugin.name);
}

async function compile(source: string) {
  const recorder = createReactCompilerRecorder(ROOT);
  const preset = reactCompilerPreset(reactCompilerOptions(recorder));
  const result = await transformAsync(source, {
    filename: `${ROOT}/src/Example.tsx`,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    presets: [preset.preset],
  });
  return { code: result?.code ?? "", report: recorder.report() };
}

test("off unless the build's environment says 1", async () => {
  for (const environment of [{}, { RAFT_WEB_REACT_COMPILER: "" }, { RAFT_WEB_REACT_COMPILER: "0" }]) {
    assert.equal(reactCompilerEnabled(environment), false);
    assert.deepEqual(await reactCompilerPlugins(environment, ROOT), []);
  }
  // The deployment's name alone turns nothing on.
  assert.deepEqual(await reactCompilerPlugins({ VITE_DEPLOYMENT_ENV: "staging" }, ROOT), []);
});

test("1 adds Babel with the compiler and the report plugin", async () => {
  assert.equal(reactCompilerEnabled({ RAFT_WEB_REACT_COMPILER: " 1 " }), true);
  const names = await pluginNames({ RAFT_WEB_REACT_COMPILER: "1" });
  assert.equal(names.length, 2);
  assert.equal(names[1], "raft-react-compiler-report");
});

test("any other value stops the build instead of shipping without the compiler", async () => {
  for (const value of ["true", "on", "yes", "2"]) {
    assert.throws(() => reactCompilerEnabled({ RAFT_WEB_REACT_COMPILER: value }), /RAFT_WEB_REACT_COMPILER must be 1 or 0/);
    await assert.rejects(reactCompilerPlugins({ RAFT_WEB_REACT_COMPILER: value }, ROOT), /must be 1 or 0/);
  }
});

test("marks the page, and refuses a page it cannot mark", () => {
  assert.equal(
    markReactCompilerHtml('<!DOCTYPE html>\n<html lang="en" class="notranslate">\n<head></head></html>'),
    '<!DOCTYPE html>\n<html data-react-compiler="1" lang="en" class="notranslate">\n<head></head></html>',
  );
  assert.equal(markReactCompilerHtml("<html><body></body></html>"), '<html data-react-compiler="1"><body></body></html>');
  assert.throws(() => markReactCompilerHtml("<body></body>"), /no <html> tag/);
});

test("compiles a component and counts it", async () => {
  const { code, report } = await compile(
    "export function Greeting({ name }: { name: string }) {\n  return <p>{name.toUpperCase()}</p>;\n}\n",
  );
  assert.match(code, /react\/compiler-runtime/);
  assert.equal(report.compiled, 1);
  assert.equal(report.left, 0);
  assert.equal(report.filesCompiled, 1);
});

test("a component the compiler cannot compile is left as written, with its reason, and nothing throws", async () => {
  const source = [
    'import { useRef } from "react";',
    "export function Good({ name }: { name: string }) {",
    "  return <p>{name}</p>;",
    "}",
    "export function ReadsRef() {",
    "  const count = useRef(0);",
    "  return <p>{count.current}</p>;",
    "}",
    "",
  ].join("\n");
  const { code, report } = await compile(source);
  assert.equal(report.compiled, 1);
  assert.equal(report.left, 1);
  assert.deepEqual(report.leftFunctions, [
    { file: "src/Example.tsx", line: 5, kind: "CompileError", reason: "Cannot access refs during render" },
  ]);
  assert.deepEqual(report.reasons, { "Cannot access refs during render": 1 });
  // Left as written: the ref read is still in the output, outside any memo cache.
  assert.match(code, /function ReadsRef\(\) \{\s+const count = useRef\(0\);\s+return <p>\{count\.current\}<\/p>;/);
});
