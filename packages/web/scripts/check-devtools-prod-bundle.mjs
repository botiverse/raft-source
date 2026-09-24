import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(webRoot, "dist");
const forbidden = ["react-grab", "react-scan"];
const extensions = new Set([".js", ".css", ".html", ".map"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    yield path;
  }
}

function hasCheckedExtension(path) {
  return [...extensions].some((extension) => path.endsWith(extension));
}

const hits = [];
for await (const file of walk(distRoot)) {
  if (!hasCheckedExtension(file)) continue;
  const content = await readFile(file, "utf8");
  for (const token of forbidden) {
    if (content.includes(token)) hits.push(`${relative(webRoot, file)} contains ${token}`);
  }
}

if (hits.length > 0) {
  console.error("[devtools-prod-bundle] dev-only package names leaked into production output:");
  for (const hit of hits) console.error(`- ${hit}`);
  process.exit(1);
}

console.log("[devtools-prod-bundle] react-grab/react-scan absent from production output");
