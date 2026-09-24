import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(packageRoot, "src", "wikiAgentWorkspacePack");
const outputPath = path.join(packageRoot, "src", "generated", "wikiAgentWorkspacePack.ts");

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return listFiles(path.join(directory, entry.name), relativePath);
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported Wiki workspace pack entry: ${relativePath}`);
      }
      return [relativePath];
    })
    .sort(comparePaths);
}

const sourceFiles = listFiles(sourceRoot).map((relativePath) => {
  const content = readFileSync(path.join(sourceRoot, ...relativePath.split("/")), "utf8");
  const size = Buffer.byteLength(content);
  return {
    relativePath,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    size,
  };
});

const canonical = JSON.stringify({
  protocolVersion: 1,
  files: sourceFiles.map(({ relativePath, content }) => ({ relativePath, content })),
});
const packId = createHash("sha256").update(canonical).digest("hex");
const generated = `// GENERATED FILE - DO NOT EDIT DIRECTLY.
// Source: packages/server/src/wikiAgentWorkspacePack/**
// Regenerate with: pnpm --filter @botiverse/raft-server generate:wiki-workspace-pack

import type { WikiWorkspacePack } from "@botiverse/raft-shared";

export const WIKI_AGENT_WORKSPACE_PACK: WikiWorkspacePack = ${JSON.stringify({
  protocolVersion: 1,
  packId,
  files: sourceFiles,
}, null, 2)};
`;

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, generated);
