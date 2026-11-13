import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const servicesDir = dirname(fileURLToPath(import.meta.url));

test("inbox suppression table writes are centralized in the registry module", () => {
  const serviceFiles = readdirSync(servicesDir)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".contract.test.ts"));

  const directMutators = serviceFiles.filter((file) => {
    if (file === "inboxSuppressionWriters.ts") return false;
    const source = readFileSync(resolve(servicesDir, file), "utf8");
    return /\.(?:insert|update|delete)\(\s*inboxSuppressionStates\s*\)/.test(source);
  });

  assert.deepEqual(directMutators, []);
});
