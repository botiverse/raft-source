import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  WIKI_WORKSPACE_PACK_PROTOCOL_VERSION,
  canonicalizeWikiWorkspacePackFiles,
  isCompleteWikiWorkspaceEnsureReceipt,
  type WikiWorkspacePack,
} from "./index.js";

function makePack(): WikiWorkspacePack {
  const files = [
    { relativePath: "CLAUDE.md", content: "@AGENTS.md\n" },
    { relativePath: "AGENTS.md", content: "# Wiki Agent\n" },
  ].map((file) => ({
    ...file,
    sha256: createHash("sha256").update(file.content).digest("hex"),
    size: Buffer.byteLength(file.content),
  }));
  return {
    protocolVersion: WIKI_WORKSPACE_PACK_PROTOCOL_VERSION,
    packId: createHash("sha256")
      .update(canonicalizeWikiWorkspacePackFiles(files))
      .digest("hex"),
    files,
  };
}

test("Wiki workspace pack canonicalization is input-order independent", () => {
  const pack = makePack();
  assert.equal(
    canonicalizeWikiWorkspacePackFiles(pack.files),
    canonicalizeWikiWorkspacePackFiles([...pack.files].reverse()),
  );
  assert.match(
    canonicalizeWikiWorkspacePackFiles(pack.files),
    /"relativePath":"AGENTS\.md".*"relativePath":"CLAUDE\.md"/,
  );
});

test("Wiki workspace receipt validation binds agent, pack, paths, hashes, and sizes", () => {
  const pack = makePack();
  const receipt = {
    agentId: "wiki-agent",
    packId: pack.packId,
    files: pack.files.map(({ relativePath, sha256, size }) => ({
      relativePath,
      sha256,
      size,
    })),
  };

  assert.equal(isCompleteWikiWorkspaceEnsureReceipt(receipt, "wiki-agent", pack), true);
  assert.equal(
    isCompleteWikiWorkspaceEnsureReceipt(
      { ...receipt, packId: "0".repeat(64) },
      "wiki-agent",
      pack,
    ),
    false,
  );
  assert.equal(
    isCompleteWikiWorkspaceEnsureReceipt(
      { ...receipt, files: [receipt.files[0]!, receipt.files[0]!] },
      "wiki-agent",
      pack,
    ),
    false,
  );
  assert.equal(
    isCompleteWikiWorkspaceEnsureReceipt(
      {
        ...receipt,
        files: receipt.files.map((file, index) => (
          index === 0 ? { ...file, size: file.size + 1 } : file
        )),
      },
      "wiki-agent",
      pack,
    ),
    false,
  );
});
