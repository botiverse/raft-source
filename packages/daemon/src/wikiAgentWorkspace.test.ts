import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  canonicalizeWikiWorkspacePackFiles,
  type WikiWorkspacePack,
} from "@botiverse/raft-shared";
import {
  ensureWikiAgentWorkspace,
  ensureWikiWorkspaceIfConfigured,
} from "./wikiAgentWorkspace.js";

function makePack(
  contentByPath: Record<string, string>,
): WikiWorkspacePack {
  const files = Object.entries(contentByPath)
    .map(([relativePath, content]) => ({
      relativePath,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    protocolVersion: 1,
    packId: createHash("sha256")
      .update(canonicalizeWikiWorkspacePackFiles(files))
      .digest("hex"),
    files,
  };
}

const BASE_FILES = {
  "AGENTS.md": "# Wiki Agent\n",
  "CLAUDE.md": "@AGENTS.md\n",
  ".agents/skills/ingest.md": "# Ingest\n",
  ".claude/skills/ingest.md": "# Ingest adapter\n",
};

async function withWorkspace(
  fn: (workspace: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-pack-test-"));
  const workspace = path.join(root, "agent");
  await mkdir(workspace);
  try {
    await fn(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Wiki workspace pack scope permits a ninth skill without a daemon filename change", async () => {
  await withWorkspace(async (workspace) => {
    const first = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, first);
    await writeFile(path.join(workspace, "notes.md"), "user-owned\n");

    const second = makePack({
      ...BASE_FILES,
      ".agents/skills/reconcile.md": "# Reconcile\n",
      ".claude/skills/reconcile.md": "# Reconcile adapter\n",
    });
    const receipt = await ensureWikiAgentWorkspace("agent", workspace, second);

    assert.equal(receipt.packId, second.packId);
    assert.equal(
      await readFile(path.join(workspace, ".agents", "skills", "reconcile.md"), "utf8"),
      "# Reconcile\n",
    );
    assert.equal(await readFile(path.join(workspace, "notes.md"), "utf8"), "user-owned\n");
    await ensureWikiWorkspaceIfConfigured(workspace, {
      [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
    });
  });
});

test("Wiki workspace pack update removes only paths managed by the previous marker", async () => {
  await withWorkspace(async (workspace) => {
    const first = makePack({
      ...BASE_FILES,
      ".agents/skills/retired.md": "# Retired\n",
    });
    await ensureWikiAgentWorkspace("agent", workspace, first);
    await writeFile(path.join(workspace, ".agents", "skills", "user-note.txt"), "keep\n");

    const second = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, second);

    await assert.rejects(
      readFile(path.join(workspace, ".agents", "skills", "retired.md")),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(path.join(workspace, ".agents", "skills", "user-note.txt"), "utf8"),
      "keep\n",
    );
  });
});

test("Wiki workspace pack rolls back files and marker when installation fails after backup begins", async () => {
  await withWorkspace(async (workspace) => {
    const first = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, first);
    const blockedPath = path.join(workspace, ".agents", "skills", "new.md");
    await mkdir(blockedPath);
    const second = makePack({
      ...BASE_FILES,
      "AGENTS.md": "# Updated Wiki Agent\n",
      ".agents/skills/new.md": "# New\n",
    });

    await assert.rejects(
      ensureWikiAgentWorkspace("agent", workspace, second),
      /not a regular file/,
    );
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Wiki Agent\n");
    await ensureWikiWorkspaceIfConfigured(workspace, {
      [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
    });
  });
});

test("Wiki workspace pack rejects traversal and root-scope expansion before mutation", async () => {
  await withWorkspace(async (workspace) => {
    const valid = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, valid);
    const originalAgents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");

    for (const relativePath of ["../AGENTS.md", ".agents\\skills\\evil.md", "schema.md"]) {
      const invalid = makePack({
        ...BASE_FILES,
        [relativePath]: "# Not allowed\n",
      });
      await assert.rejects(
        ensureWikiAgentWorkspace("agent", workspace, invalid),
        /outside the allowed scope/,
      );
      assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), originalAgents);
    }
  });
});

test("Wiki workspace pack refuses a symlink escape and preserves the last valid pack", async () => {
  await withWorkspace(async (workspace) => {
    const valid = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, valid);
    const outside = await mkdtemp(path.join(os.tmpdir(), "wiki-pack-outside-"));
    try {
      await rm(path.join(workspace, ".claude", "skills"), { recursive: true, force: true });
      await symlink(outside, path.join(workspace, ".claude", "skills"), "dir");
      await assert.rejects(
        ensureWikiAgentWorkspace("agent", workspace, valid),
        /crosses a symbolic link/,
      );
      assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Wiki Agent\n");
      await assert.rejects(
        ensureWikiWorkspaceIfConfigured(workspace, {
          [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
        }),
        /no valid installed workspace pack/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("Wiki workspace launch validation detects tampering and ensure repairs from the exact pack", async () => {
  await withWorkspace(async (workspace) => {
    const pack = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, pack);
    await writeFile(path.join(workspace, "AGENTS.md"), "# Tampered\n");

    await assert.rejects(
      ensureWikiWorkspaceIfConfigured(workspace, {
        [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
      }),
      /no valid installed workspace pack/,
    );

    await ensureWikiAgentWorkspace("agent", workspace, pack);
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Wiki Agent\n");
  });
});

test("Wiki workspace validation rejects a symlinked marker and oversized managed file", async () => {
  await withWorkspace(async (workspace) => {
    const pack = makePack(BASE_FILES);
    await ensureWikiAgentWorkspace("agent", workspace, pack);
    const markerPath = path.join(workspace, ".slock", "wiki-workspace-pack.json");
    const outsideMarker = path.join(path.dirname(workspace), "outside-marker.json");
    await rename(markerPath, outsideMarker);
    await symlink(outsideMarker, markerPath);

    await assert.rejects(
      ensureWikiWorkspaceIfConfigured(workspace, {
        [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
      }),
      /symbolic link/,
    );

    await rm(markerPath);
    await rename(outsideMarker, markerPath);
    await writeFile(path.join(workspace, "AGENTS.md"), "x".repeat(65 * 1024));
    await assert.rejects(
      ensureWikiWorkspaceIfConfigured(workspace, {
        [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
      }),
      /no valid installed workspace pack/,
    );

    await ensureWikiAgentWorkspace("agent", workspace, pack);
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# Wiki Agent\n");
  });
});
