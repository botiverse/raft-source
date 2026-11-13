// The package's `cont` bin (dist/cont.js) is `raft __continue`: the same
// command the daemon's `cont` wrapper runs, for agents that installed the CLI
// themselves. Run the generated wrapper against a stand-in for the bundled CLI
// and check what the CLI receives.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("the package bins include cont, pointing at the generated wrapper", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin?: Record<string, string> };
  assert.deepEqual(pkg.bin, { raft: "dist/raft.js", slock: "dist/slock.js", cont: "dist/cont.js" });
});

test("cont runs the CLI as raft __continue: its arguments, stdin and exit status pass through", () => {
  execFileSync(process.execPath, ["--import", "@oxc-node/core/register", fileURLToPath(new URL("../scripts/write-dist-package.ts", import.meta.url))]);
  const dir = mkdtempSync(path.join(os.tmpdir(), "raft-cont-bin-"));
  try {
    copyFileSync(fileURLToPath(new URL("../dist/cont.js", import.meta.url)), path.join(dir, "cont.js"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    // Stands in for the bundled CLI: record what it was run with, exit as a paused command would.
    writeFileSync(path.join(dir, "index.js"), [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "writeFileSync(process.env.CONT_TEST_OUT, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  invocation: process.env.SLOCK_CLI_INVOCATION_NAME,",
      '  stdin: readFileSync(0, "utf8"),',
      "}));",
      "process.exit(10);",
      "",
    ].join("\n"));
    const out = path.join(dir, "call.json");
    const run = spawnSync(process.execPath, [path.join(dir, "cont.js"), "k7q2m3x9ab", "b"], {
      env: { ...process.env, CONT_TEST_OUT: out },
      input: "my new message\n",
      encoding: "utf8",
    });
    assert.equal(run.status, 10, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
      argv: ["__continue", "k7q2m3x9ab", "b"],
      invocation: "raft",
      stdin: "my new message\n",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
