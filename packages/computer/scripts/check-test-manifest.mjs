import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_TEST_FILE_COUNT = 76;

const root = new URL("..", import.meta.url);
const srcDir = fileURLToPath(new URL("src", root));

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

const testFiles = (await collectTestFiles(srcDir)).sort();
const count = testFiles.length;
console.log(`Computer test files selected: ${count}`);

if (count !== EXPECTED_TEST_FILE_COUNT) {
  console.error(
    `Expected ${EXPECTED_TEST_FILE_COUNT} Computer test files; found ${count}. ` +
      "Update EXPECTED_TEST_FILE_COUNT in packages/computer/scripts/check-test-manifest.mjs when intentionally adding or removing tests.",
  );
  process.exit(1);
}
