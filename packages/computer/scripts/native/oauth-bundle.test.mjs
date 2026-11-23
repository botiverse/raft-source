import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("standalone CJS bundle derives Codex and Pi session OAuth without an adjacent SDK module tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-oauth-bundle-"));
  try {
    const entry = fileURLToPath(new URL("../../../daemon/src/bundledPiOAuth.ts", import.meta.url));
    const outfile = join(dir, "computer-bundle.cjs");
    await build({
      stdin: {
        contents: `import { verifyBundledPiOAuth } from ${JSON.stringify(entry)};
          verifyBundledPiOAuth().then(() => console.log("oauth-bundle-ok")).catch(error => {
            console.error(error); process.exitCode = 1;
          });`,
        resolveDir: dir,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      define: { "import.meta.url": "__slockImportMetaUrl" },
      banner: { js: 'const __slockImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;' },
    });
    // No account environment or SDK files beside the bundle. The flow's toAuth
    // only derives from this synthetic credential; it must not log in/refresh.
    const result = spawnSync(process.execPath, [outfile], {
      cwd: dir,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout.trim(), "oauth-bundle-ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Pi agents' Bedrock requests go through pi-ai's lazy Bedrock loader, which the
// daemon registers (bundledPiOAuth.ts). Without it pi-ai imports the stream
// through a variable specifier that finds no file beside a bundle; the SEA
// build's own smoke (__verify-bundled-bedrock) covers the separate asset.
test("standalone CJS bundle sends a pi Bedrock request without an adjacent SDK module tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raft-bedrock-bundle-"));
  try {
    const entry = fileURLToPath(new URL("../../../daemon/src/bundledPiOAuth.ts", import.meta.url));
    const outfile = join(dir, "computer-bundle.cjs");
    await build({
      stdin: {
        contents: `import { verifyBundledPiBedrock } from ${JSON.stringify(entry)};
          verifyBundledPiBedrock().then(() => console.log("bedrock-bundle-ok")).catch(error => {
            console.error(error); process.exitCode = 1;
          });`,
        resolveDir: dir,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      define: { "import.meta.url": "__slockImportMetaUrl" },
      banner: { js: 'const __slockImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;' },
    });
    const result = spawnSync(process.execPath, [outfile], {
      cwd: dir,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout.trim(), "bedrock-bundle-ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
