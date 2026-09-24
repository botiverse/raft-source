import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// REGRESSION pin: the menu-bar app bundle (`dist/main.js`) must not leave any
// workspace dep external. `@botiverse/raft-shared` / `@botiverse/raft-trace-client` are
// source-only TS packages (`main: src/index.ts`, no build); leaving them
// external would have Electron resolve them to raw `.ts` source at runtime
// and fail on bundler-style `.js`-extension internal imports
// (#wg-raft-computer:69c76b6e — broke menu-bar Electron startup post-#3223).
//
// `@botiverse/raft-computer/lib` itself ships a built bundle, but its bundle
// leaves shared/trace-client external — so transitively this bundle has to
// inline raft-computer's lib too, otherwise the resolver still hits the same
// raw-TS imports.
//
// This test runs against `dist/main.js` and is therefore gated behind a
// successful `pnpm run build` (the `verify` script doesn't currently build,
// but the CI workflow runs `pnpm run build` followed by tests). We skip when
// the bundle is missing rather than failing — running `pnpm test:unit` from a
// fresh checkout without `pnpm run build` first should not be misread as a
// regression.

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, "..", "dist", "main.js");

async function readBundle(): Promise<string | null> {
  try {
    return await readFile(BUNDLE, "utf8");
  } catch {
    return null;
  }
}

test("dist/main.js bundle does not import any workspace package at runtime", async (t) => {
  const bundle = await readBundle();
  if (bundle === null) {
    t.skip("dist/main.js missing — run `pnpm run build` first");
    return;
  }
  // Patterns that would indicate an unbundled workspace import survived:
  //   import { x } from "@botiverse/raft-shared"
  //   import { y } from "@botiverse/raft-trace-client"
  //   import { z } from "@botiverse/raft-computer"  (or "/lib")
  const externalImport = /from\s+["'](@botiverse\/raft-(?:shared|trace-client)|@botiverse\/raft-computer(?:\/[^"']*)?)["']/g;
  const hits = bundle.match(externalImport) ?? [];
  assert.deepEqual(
    hits,
    [],
    `bundle leaked unbundled workspace imports — these must be in tsup.config.ts noExternal:\n${hits.join("\n")}`,
  );
});
