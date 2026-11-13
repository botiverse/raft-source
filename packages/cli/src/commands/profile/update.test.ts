import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PROFILE_AVATAR_BYTES } from "@botiverse/raft-shared/src/agentCliSurface";

import { CliError } from "../../core/errors";
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
