import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MAX_PROFILE_AVATAR_BYTES } from "@botiverse/raft-shared/src/agentCliSurface";
import { descriptionLinkFixTexts, type DescriptionLinkWarning } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { CliError } from "../../core/errors";
import { buildRaftProgram } from "../../program";
import { readAvatarFile } from "./update";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngOfSize(dir: string, bytes: number): string {
  const data = new Uint8Array(bytes);
  data.set(PNG_SIGNATURE);
  const file = join(dir, "avatar.png");
  writeFileSync(file, data);
  return file;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "raft-cli-avatar-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("readAvatarFile accepts an avatar at the Server's 5 MB limit", () => {
  assert.equal(MAX_PROFILE_AVATAR_BYTES, 5 * 1024 * 1024);
  const avatar = readAvatarFile(pngOfSize(dir, MAX_PROFILE_AVATAR_BYTES));
  assert.equal(avatar.mimeType, "image/png");
  assert.equal(avatar.buffer.length, MAX_PROFILE_AVATAR_BYTES);
});

test("readAvatarFile rejects an avatar over the limit", () => {
  assert.throws(
    () => readAvatarFile(pngOfSize(dir, MAX_PROFILE_AVATAR_BYTES + 1)),
    (error: unknown) => error instanceof CliError && String(error.code) === "PROFILE_AVATAR_TOO_LARGE",
  );
});

// #457: the Server's warnings about the saved description's links are result
// lines on stdout after the profile (the save succeeded: exit 0, nothing on
// stderr), each naming its link, every fix with the real id in any command,
// the person-only fix phrased as asking a person; --json carries them.
const agentContext: AgentContext = {
  agentId: "agent-1", serverUrl: "https://raft.example", serverId: "server-1", token: "secret-token",
  clientMode: "self-hosted-runner", secretSource: "profile-credential-file", activeCapabilities: null,
};
const ARTIFACT_ID = "pt_6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const LINK = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";
const warning: DescriptionLinkWarning = {
  code: "conversation",
  url: LINK,
  object: { kind: "artifact", id: ARTIFACT_ID },
  fixes: descriptionLinkFixTexts("conversation", { kind: "artifact", id: ARTIFACT_ID }, { writer: "agent", subject: "agent", channel: "#ops" }),
};
const profile = {
  kind: "agent", id: "agent-1", isSelf: true, name: "remy", displayName: "Remy", description: `Notes: ${LINK}`, avatarUrl: null,
  status: "active", serverRole: "member", runtime: "claude", model: "claude", reasoningEffort: null, executionMode: null,
  computerId: null, computerName: null, computerHostname: null, daemonVersion: null, creator: null, createdAgents: [],
  createdAt: "2026-11-01T00:00:00.000Z", deletedAt: null,
};

async function runUpdate(argv: string[], answer: Record<string, unknown>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildRaftProgram({
    io: {
      stdout: { write: (c: string | Uint8Array) => { stdout.push(String(c)); return true; } },
      stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } },
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
    },
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(): Promise<ApiResponse<T>> => ({ ok: true, status: 200, data: answer, error: null }) as unknown as ApiResponse<T>,
    }) as any,
  });
  let error: unknown = null;
  await program.parseAsync(["profile", "update", ...argv], { from: "user" }).catch((caught) => { error = caught; });
  return { stdout: stdout.join(""), stderr: stderr.join(""), error };
}

test("raft profile update prints the description's link warnings on stdout after the profile, with every fix", async () => {
  const { stdout, stderr, error } = await runUpdate(["--description", `Notes: ${LINK}`], { ...profile, warnings: [warning] });
  assert.equal(error, null);
  assert.equal(stderr, "");
  const lines = stdout.split("\n");
  const first = lines.findIndex((line) => line.startsWith("Warning: "));
  assert.ok(first > 0, "after the profile card");
  assert.match(lines[first]!, new RegExp(`^Warning: your description was saved, but Artifact ${ARTIFACT_ID} \\(${LINK.replace(/[./]/g, "\\$&")}\\) is shared only in one conversation`));
  const fixes = lines.slice(first + 1).filter((line) => line.startsWith("  Fix: "));
  assert.equal(fixes.length, 3, "every fix, not only the move");
  assert.ok(!fixes[0]!.includes(`raft artifact move ${ARTIFACT_ID}`), "widening this one is not the first fix");
  assert.ok(fixes[fixes.length - 1]!.includes(`raft artifact move ${ARTIFACT_ID} --to server`), "the whole server is the last fix");
  assert.match(stdout, /\nYour description is shown to everyone in this server, .*\n$/, "one reminder line after the warnings");
  assert.ok(fixes.some((line) => line.includes(`raft artifact move ${ARTIFACT_ID} --to server`) && line.includes("everyone in the server will be able to see all of its contents")));
  assert.ok(fixes.every((line) => !line.includes("Anyone with the link")), "an agent's description is read by its server: never ask for public");
  assert.ok(fixes.some((line) => line.includes("separate version") && line.includes("raft artifact move <new id> --to server")), "the copy only needs to reach the server");
  assert.ok(fixes.some((line) => line.includes(`raft channel update --target "#ops" --announcement ${ARTIFACT_ID}`)), JSON.stringify(fixes));
});

test("raft profile update --json carries the warnings; without any nothing is added", async () => {
  const json = await runUpdate(["--description", `Notes: ${LINK}`, "--json"], { ...profile, warnings: [warning] });
  assert.deepEqual((JSON.parse(json.stdout) as { data: { warnings: unknown } }).data.warnings, [warning]);
  const plain = await runUpdate(["--description", "Plain"], profile);
  assert.ok(!plain.stdout.includes("Warning:"));
});
