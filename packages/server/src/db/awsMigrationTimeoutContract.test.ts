import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.resolve(SERVER_ROOT, "../../RELEASE_SOURCE"));

// An options object's `skip` overrides a chained `skipIf`, so both conditions
// go through `skipIf`.
test.skipIf(process.platform === "win32" || inSourceSnapshot)(
  "AWS runner scopes a bounded statement timeout to the Drizzle task",
  async () => {
    const contractScript = path.resolve(
      SERVER_ROOT,
      "../../scripts/deploy/aws-run-server-migrations.test.sh",
    );
    const { stdout } = await execFileAsync("bash", [contractScript]);

    assert.match(stdout, /timeout contract: PASS/);
  },
);
