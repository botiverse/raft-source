import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { migrationNoticePresentation } from "../src/components/agentMigration/presentation";
import type { AgentMigrationNotice } from "../src/components/agentMigration/realtime";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import type { Machine } from "../src/store/machineStore";

const intl = createIntl({ locale: "en", messages: en as Record<string, string> });
const zhIntl = createIntl({ locale: "zh-cn", messages: zhCn as Record<string, string> });
const machines = [
  { id: "m-source", name: "laptop", status: "online" },
  { id: "m-target", name: "hetzner", status: "online" },
] as Machine[];
const GIB = 1024 ** 3;

function notice(overrides: Partial<AgentMigrationNotice>): AgentMigrationNotice {
  return {
    agentId: "agent-1",
    migrationRef: "mig_test",
    state: "ready",
    revision: 3,
    sourceMachineId: "m-source",
    targetKind: "computer",
    targetMachineId: "m-target",
    ...overrides,
  };
}

function message(value: AgentMigrationNotice, formatMessage = intl.formatMessage): string {
  return migrationNoticePresentation(formatMessage, value, machines, (iso) => iso, { agentName: "Migration Agent", formatClock: (iso) => iso }).message;
}

test("while the target downloads, the stage shows the percent and the downloaded and total size", () => {
  const downloading = notice({
    transferProgress: { receivedBytes: 1.2 * GIB, totalBytes: 2.5 * GIB, receivedChunks: 150, totalChunks: 320 },
  });

  assert.equal(message(downloading), "hetzner is downloading the workspace: 48% (1.2 GiB of 2.5 GiB, compressed).");
  assert.equal(message(downloading, zhIntl.formatMessage), "hetzner 正在下载工作区：48%（1.2 GiB / 2.5 GiB，压缩后）。");
});

test("the percent stays below 100 until the last chunk is downloaded", () => {
  const lastChunkPending = notice({
    transferProgress: { receivedBytes: 2.5 * GIB - 1, totalBytes: 2.5 * GIB, receivedChunks: 319, totalChunks: 320 },
  });

  assert.match(message(lastChunkPending), /: 99% \(/);
});

test("once every chunk is downloaded the stage says it is unpacking", () => {
  const downloaded = notice({
    transferProgress: { receivedBytes: 2.5 * GIB, totalBytes: 2.5 * GIB, receivedChunks: 320, totalChunks: 320 },
  });

  assert.equal(message(downloaded), "Download finished. Unpacking the workspace on hetzner.");
  assert.equal(message(notice({ state: "in_transit" })), "Download finished. Unpacking the workspace on hetzner.");
});

test("a status without download progress keeps the plain ready copy", () => {
  assert.equal(message(notice({})), "The workspace is uploaded. hetzner is downloading it.");
  assert.equal(message(notice({ transferProgress: null })), "The workspace is uploaded. hetzner is downloading it.");
});
