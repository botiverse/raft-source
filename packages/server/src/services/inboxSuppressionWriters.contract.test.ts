import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const servicesDir = dirname(fileURLToPath(import.meta.url));
const channelServiceSource = readFileSync(resolve(servicesDir, "channelService.ts"), "utf8");
const sequencerSource = readFileSync(resolve(servicesDir, "readMutationSequencer.ts"), "utf8");
const writerSource = readFileSync(resolve(servicesDir, "inboxSuppressionWriters.ts"), "utf8");

test("done-state writers are paired with suppression registry calls", () => {
  const channelServiceSnippets = [
    "writeSite: INBOX_SUPPRESSION_WRITE_SITES.unfollowThreadForFollower",
    "await clearThreadDoneSuppression({ userId, threadChannelId, executor: tx });",
    "await clearFollowedThreadSuppressionForAll({ threadChannelId, executor: tx });",
    "await clearFollowedThreadSuppressionForReceiver({",
  ];

  for (const snippet of channelServiceSnippets) {
    assert.ok(
      channelServiceSource.includes(snippet),
      `channelService.ts is missing suppression registry hook: ${snippet}`,
    );
  }

  for (const snippet of ["await writeChannelInboxSuppression({", "await writeThreadDoneSuppression({"]) {
    assert.ok(
      sequencerSource.includes(snippet),
      `readMutationSequencer.ts is missing atomic Done suppression hook: ${snippet}`,
    );
  }
  assert.match(sequencerSource, /throughActivitySeq:\s*input\.throughSeq/);

  assert.ok(
    channelServiceSource.includes("RETURNING thread_channel_id"),
    "recordThreadFollow must only clear suppression when the follow write actually takes effect",
  );
});

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
  assert.match(writerSource, /insert\(inboxSuppressionStates\)/);
  assert.match(writerSource, /delete\(inboxSuppressionStates\)/);
});
