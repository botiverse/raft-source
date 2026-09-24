import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(repoRoot, "src");
const blocked = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (/\.(?:cjs|js|jsx|mjs)$/.test(entry.name)) {
      blocked.push(relative(repoRoot, full));
    }
  }
}

walk(sourceRoot);

if (blocked.length > 0) {
  console.error("Runtime JavaScript files are not allowed under packages/web/src.");
  console.error("Use .ts/.tsx so source participates in the TypeScript program:");
  for (const file of blocked) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}
