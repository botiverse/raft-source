import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compare, DEFAULT_PHASES, instrument, measure, packageOf, selectPhases, sourceStringCost } from "./measure-load-heap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_PKG = resolve(HERE, "..", "..", "..", "shared", "package.json");
// The bundle under test must contain the real zod v4 $constructor the tool patches.
const ZOD_DIR = dirname(createRequire(SHARED_PKG).resolve("zod/package.json"));

describe("measure-load-heap", () => {
  let root;
  let bundlePath;
  let minifiedPath;
  const phases = [
    { name: "cli", module: "packages/app/src/cli.ts" },
    { name: "daemon", module: "packages/lib/src/core.ts" },
  ];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "measure-load-heap-test-"));
    const write = (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    // Same shape as the computer bundle: phase modules are reached by dynamic
    // import, so esbuild wraps them in `__esm` init functions.
    write("packages/app/src/index.ts", 'export const load = () => Promise.all([import("./cli"), import("../../lib/src/core")]);\n');
    write("packages/app/src/cli.ts", 'import { z } from "zod";\nexport const a = z.object({ id: z.string() });\n');
    write("packages/lib/src/core.ts", 'import { z } from "zod";\nexport const b = z.string().optional();\nexport const c = z.number();\n');
    const options = {
      absWorkingDir: root,
      entryPoints: ["packages/app/src/index.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      nodePaths: [dirname(ZOD_DIR)],
      logLevel: "silent",
    };
    bundlePath = join(root, "bundle.cjs");
    minifiedPath = join(root, "bundle.min.cjs");
    await build({ ...options, outfile: bundlePath });
    // The SEA build minifies whitespace, which drops the module markers.
    await build({ ...options, outfile: minifiedPath, minifyWhitespace: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("attributes zod instances to the module that created them, phase by phase", () => {
    const result = measure(bundlePath, { phases });
    expect(result.phases.map((p) => [p.phase, p.zod])).toEqual([
      ["empty", 0],
      ["evaluate", 0],
      ["cli", 2],
      ["daemon", 5],
    ]);
    expect(result.zod.byPackage).toEqual({ "packages/app": 2, "packages/lib": 3 });
    expect(Object.fromEntries(result.zod.topModules)).toEqual({
      "packages/app/src/cli.ts": 2,
      "packages/lib/src/core.ts": 3,
    });
    // zod 4.6 ships non-Latin-1 text (`…`, `—`), so the bundle's cost follows its actual characters.
    expect(result.source).toEqual(sourceStringCost(readFileSync(bundlePath, "utf8")));
  });

  it("still counts phases on a whitespace-minified bundle, without attribution", () => {
    const result = measure(minifiedPath, { phases });
    expect(result.phases.map((p) => [p.phase, p.zod])).toEqual([
      ["empty", 0],
      ["evaluate", 0],
      ["cli", 2],
      ["daemon", 5],
    ]);
    expect(result.zod).toMatchObject({ total: 5, byPackage: null, topModules: null });
  });

  it("fails loudly when the bundle has no zod or the phase module is not lazily wrapped", () => {
    expect(() => instrument("console.log(1)")).toThrow(/zod \$constructor not found/);
    const zodLike = "function $constructor(name, init) {\n  const inst = params?.Parent ? new Definition() : this;\n}\n";
    expect(() => instrument(zodLike, [{ name: "x", module: "packages/x/src/x.ts" }])).toThrow(/not lazily wrapped/);
    // zod 4.6 builds the Parent case through a helper instead of `new Definition()`.
    const zod46Like = "function $constructor(name, init) {\n  const inst = params?.Parent ? newError(Definition) : this;\n}\n";
    expect(() => instrument(zod46Like, [{ name: "x", module: "packages/x/src/x.ts" }])).toThrow(/not lazily wrapped/);
  });

  it("charges two bytes per char once any char is beyond Latin-1", () => {
    expect(sourceStringCost("abcé")).toMatchObject({ nonLatin1: 0, bytesPerChar: 1 });
    expect(sourceStringCost("abc—")).toMatchObject({ nonLatin1: 1, bytesPerChar: 2 });
  });

  it("selects phases by name in load order, rejecting unknown ones", () => {
    expect(selectPhases(undefined)).toBe(DEFAULT_PHASES);
    expect(selectPhases("cli").map((p) => p.name)).toEqual(["cli"]);
    expect(selectPhases("daemon, cli").map((p) => p.name)).toEqual(["cli", "daemon"]);
    expect(() => selectPhases("cli,runner")).toThrow(/unknown phase\(s\): runner/);
  });

  it("measures only the selected phases (lite bundle without a daemon)", () => {
    const result = measure(bundlePath, { phases: phases.slice(0, 1) });
    expect(result.phases.map((p) => [p.phase, p.zod])).toEqual([
      ["empty", 0],
      ["evaluate", 0],
      ["cli", 2],
    ]);
  });

  it("names packages from bundle module paths", () => {
    expect(packageOf("packages/shared/src/agentApiContract.ts")).toBe("packages/shared");
    expect(packageOf("packages/daemon/dist/core-DaU4eC0l.js")).toBe("packages/daemon (prebuilt dist)");
    expect(packageOf("node_modules/.pnpm/@botiverse+kimi-code-sdk@0.34.0/node_modules/@botiverse/kimi-code-sdk/dist/index.mjs")).toBe(
      "@botiverse/kimi-code-sdk",
    );
    expect(packageOf("node_modules/.pnpm/undici@8.10.2/node_modules/undici/lib/web/fetch/index.js")).toBe("undici");
  });

  it("fails the baseline comparison only when the loaded heap grows past the allowance", () => {
    const at = (heapMB, total) => ({ phases: [{ heapMB: 1 }, { heapMB }], zod: { total } });
    expect(compare(at(110, 50), at(100, 40), 8)).toEqual({ heapDeltaMB: 10, zodDelta: 10, ok: false });
    expect(compare(at(90, 30), at(100, 40), 8)).toEqual({ heapDeltaMB: -10, zodDelta: -10, ok: true });
  });
});
