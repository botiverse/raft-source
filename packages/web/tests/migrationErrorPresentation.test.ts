import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntl } from "react-intl";

import {
  migrationErrorPresentation,
  parseMigrationComputerCapabilityDetails,
  parseMigrationResumableCapabilityDetail,
} from "../src/utils/migrationErrorPresentation";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

// The module holds MessageIds now, so the assertions below still pin the exact
// rendered English — they just get it by formatting, the way the product does.
// Keeping the literal expectations is deliberate: they are what a user reads,
// and they are the only thing that would catch a wrong id being wired in.
const intl = createIntl({ locale: "en", messages: en as Record<string, string> });
const zhIntl = createIntl({ locale: "zh-cn", messages: zhCn as Record<string, string> });
const fm = intl.formatMessage;

test("bundle-too-large wire payload becomes human copy with an action", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    rawMessage: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=3690465725:maxBytes=3221225472:topEntries=.git%2F,2147483648;archive.tar,1073741824;media%2F,536870912",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The compressed migration bundle exceeded the 3 GiB limit. Largest workspace items before compression: .git/ (2 GiB), archive.tar (1 GiB), media/ (0.5 GiB). Ask the agent to inspect its workspace and remove unneeded large files, then try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
  assert.doesNotMatch(presentation.message, /[A-Z][A-Z0-9_]+:.*=/);
});

test("legacy bundle-too-large payload without accounting keeps an honest fallback", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    rawMessage: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=3690465725:maxBytes=3221225472",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The compressed migration bundle exceeded the 3 GiB limit. Ask the agent to inspect its workspace and remove unneeded large files, then try again.",
  );
  assert.doesNotMatch(presentation.message, /Largest workspace items/);
});

test("manifest-too-large payload explains entry-count diagnostics", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
    rawMessage: "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE:manifestBytes=73400320:maxBytes=67108864:entryCount=97079:topPaths=.git%2F,34214;src%2F,12877",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The workspace file list is too large to prepare (97,079 entries). Most entries are under: .git/ (34,214 entries), src/ (12,877 entries). Remove rebuildable or stale high-entry directories, then try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE");
  assert.doesNotMatch(presentation.message, /[A-Z][A-Z0-9_]+:.*=/);
});

test("insufficient target disk payload becomes actionable human copy", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK",
    rawMessage: "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK:requiredBytes=7516192768:availableBytes=4294967296:contentBytes=3489660928",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The target computer needs 7 GiB free to stage and install this migration, but only 4 GiB is available. Free disk space and try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK");
});

test("entry-count limit names the source preparation stage and recovery", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    rawMessage: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The source computer stopped while preparing the workspace because it contains too many files. Remove rebuildable or stale high-entry directories, then try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
  assert.doesNotMatch(presentation.message, /MIGRATION_|TRANSPORT_LOST/);
});

test("entry-count recovery payload becomes localized actionable copy", () => {
  const rawMessage = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=.git%2F,200000;src%2F,50001";
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    rawMessage,
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The source computer stopped while preparing the workspace because it contains 250,001 entries, above the 250,000 entry limit. Most entries are under: .git/ (200,000 entries), src/ (50,001 entries). Remove rebuildable or stale high-entry directories, then try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
  assert.doesNotMatch(presentation.message, /MIGRATION_|topPathCounts=/);

  const translated = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    rawMessage,
    context: "failed",
  }, zhIntl.formatMessage);
  assert.match(translated.message, /250,001 个条目.*250,000 个条目.*\.git\/.*200,000.*src\/.*50,001/);
});

test("entry-count malformed or unsafe recovery payload fails closed to specific path-free copy", () => {
  const malformedPayloads = [
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000",
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250000:maxEntries=250000:topPathCounts=src%2F,250000",
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=%2FUsers%2Fprivate,250001",
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=api-key-cache%2F,250001",
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=a%2F,1;b%2F,1;c%2F,1;d%2F,1",
  ];
  for (const rawMessage of malformedPayloads) {
    const presentation = migrationErrorPresentation({
      code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
      rawMessage,
      context: "failed",
    }, fm);
    assert.equal(
      presentation.message,
      "The source computer stopped while preparing the workspace because it contains too many files. Remove rebuildable or stale high-entry directories, then try again.",
    );
    assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
    assert.doesNotMatch(presentation.message, /Users|api-key|250,001|Most entries/);
  }
});

test("classified transfer failures explain what happened and how to recover", () => {
  const cases = [
    ["MIGRATION_WORKSPACE_ALREADY_EXISTS", /target computer.*workspace already exists.*move or back up/is],
    ["MIGRATION_WORKSPACE_COMPLETE_OLD_COPY", /target computer.*completed copy.*move or back up/is],
    ["MIGRATION_CHUNK_DIGEST_MISMATCH", /chunk failed integrity verification.*try the migration again/is],
    ["MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH", /target computer could not verify.*try the migration again/is],
    ["MIGRATION_LEASE_EXPIRED", /authorization expired.*start the migration again/is],
    ["MIGRATION_GENERATION_STALE", /plan changed.*refresh.*start again/is],
    ["MIGRATION_CONTROL_MANIFEST_INVALID", /source computer.*target computer could not verify.*update/is],
    ["MIGRATION_CONTROL_MANIFEST_TOO_LARGE", /source computer.*metadata.*remove.*then try again/is],
  ] as const;
  for (const [code, expected] of cases) {
    const presentation = migrationErrorPresentation({ code, context: "failed" }, fm);
    assert.match(presentation.message, expected, code);
    assert.equal(presentation.technicalCode, code);
    assert.doesNotMatch(presentation.message, /MIGRATION_|TRANSPORT_LOST/, code);
  }
});

test("transport loss identifies a stale target heartbeat and blocks premature retry", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_TRANSPORT_LOST",
    rawMessage: "untrusted transport detail",
    context: "failed",
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerStatus: "online",
    targetComputerStatus: "offline",
    sourceComputerLastHeartbeat: "2026-07-10T07:59:00.000Z",
    targetComputerLastHeartbeat: "2026-07-10T07:57:59.999Z",
    transportLostAt: "2026-07-10T08:00:00.000Z",
    formatTimestamp: () => "Jul 10, 8:00 AM",
  }, fm);

  assert.equal(
    presentation.message,
    "The transfer connection ended at Jul 10, 8:00 AM, before the agent arrived. Target Computer had already missed the heartbeat window at that time. Target Computer is offline now. Bring it online before retrying.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_TRANSPORT_LOST");
  assert.doesNotMatch(presentation.message, /untrusted transport detail/);
});

test("transport loss does not invent a historical side after both computers recover", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_TRANSPORT_LOST",
    context: "failed",
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerStatus: "online",
    targetComputerStatus: "online",
    sourceComputerLastHeartbeat: "2026-07-10T08:05:00.000Z",
    targetComputerLastHeartbeat: "2026-07-10T08:05:00.000Z",
    transportLostAt: "2026-07-10T08:00:00.000Z",
    formatTimestamp: () => "Jul 10, 8:00 AM",
  }, fm);

  assert.equal(
    presentation.message,
    "The transfer connection ended at Jul 10, 8:00 AM, before the agent arrived. The available heartbeat history does not show which computer disconnected then. Both computers are online now, so retrying is reasonable.",
  );
  assert.doesNotMatch(presentation.message, /Source Computer had|Target Computer had/);
});

test("transport loss treats the exact heartbeat freshness boundary as still fresh", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_TRANSPORT_LOST",
    context: "failed",
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerStatus: "online",
    targetComputerStatus: "online",
    sourceComputerLastHeartbeat: "2026-07-10T07:58:00.000Z",
    targetComputerLastHeartbeat: "2026-07-10T07:58:00.000Z",
    transportLostAt: "2026-07-10T08:00:00.000Z",
    formatTimestamp: () => "Jul 10, 8:00 AM",
  }, fm);

  assert.match(presentation.message, /heartbeat history does not show which computer/);
  assert.doesNotMatch(presentation.message, /had already missed/);
});

test("transport loss fails closed on invalid timestamps and missing current status", () => {
  const rawTimestamp = "<script>not-a-time</script>";
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_TRANSPORT_LOST",
    context: "failed",
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerLastHeartbeat: "2026-07-10T07:00:00.000Z",
    targetComputerLastHeartbeat: "2026-07-10T07:00:00.000Z",
    transportLostAt: rawTimestamp,
    formatTimestamp: (value) => value,
  }, fm);

  assert.equal(
    presentation.message,
    "The transfer connection ended before the agent arrived. The available heartbeat history does not show which computer disconnected then. Raft cannot confirm that both computers are online now. Refresh Computers before retrying.",
  );
  assert.doesNotMatch(presentation.message, /script|not-a-time/);
});

test("transport loss diagnostic is localized without changing the technical code", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_TRANSPORT_LOST",
    context: "failed",
    sourceComputerName: "源计算机",
    targetComputerName: "目标计算机",
    sourceComputerStatus: "offline",
    targetComputerStatus: "offline",
    sourceComputerLastHeartbeat: "2026-07-10T07:00:00.000Z",
    targetComputerLastHeartbeat: "2026-07-10T07:00:00.000Z",
    transportLostAt: "2026-07-10T08:00:00.000Z",
    formatTimestamp: () => "7月10日 16:00",
  }, zhIntl.formatMessage);

  assert.match(presentation.message, /7月10日 16:00.*源计算机.*目标计算机.*都已经超过心跳时限.*目前都离线.*先让两台都上线/);
  assert.equal(presentation.technicalCode, "MIGRATION_TRANSPORT_LOST");
});

test("classified entry-count failure is translated while its technical code stays stable", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    context: "failed",
  }, zhIntl.formatMessage);

  assert.match(presentation.message, /源计算机.*准备工作区.*文件过多.*删除.*重试/);
  assert.equal(presentation.technicalCode, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
});

test("unknown migration wire payload fails closed to generic human copy", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_FUTURE_FAILURE",
    rawMessage: "MIGRATION_FUTURE_FAILURE:quotedTable=secrets:params=token",
    context: "failed",
  }, fm);

  assert.equal(
    presentation.message,
    "The migration could not be completed. Make sure both computers are online, then try again.",
  );
  assert.equal(presentation.technicalCode, "MIGRATION_FUTURE_FAILURE");
  assert.doesNotMatch(presentation.message, /MIGRATION_FUTURE_FAILURE|quotedTable|params=|token/);
});

test("unsafe technical code is omitted instead of rendered", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_FAILED:<script>alert(1)</script>",
    rawMessage: "raw driver text",
    context: "start",
  }, fm);

  assert.equal(presentation.technicalCode, undefined);
  assert.equal(
    presentation.message,
    "The migration could not be started. Check both computers and try again.",
  );
});

test("deadline abort reasons provide specific recovery actions", () => {
  const presentation = migrationErrorPresentation({
    context: "aborted",
    reason: "transfer-deadline",
  }, fm);

  assert.equal(
    presentation.message,
    "The workspace transfer did not finish before the deadline. Make sure both computers stay online and the target has enough free disk space, then try again.",
  );
  assert.equal(presentation.technicalCode, "transfer-deadline");
});

test("prep deadline recovery does not claim both computers are the cause", () => {
  const presentation = migrationErrorPresentation({
    context: "aborted",
    reason: "prep-deadline",
  }, fm);

  assert.equal(
    presentation.message,
    "The source computer did not finish preparing the workspace before the deadline. Large workspaces can take longer; make sure the source is running, then try again.",
  );
  assert.doesNotMatch(presentation.message, /both computers/i);
});

test("computer capability failures list every affected computer and exact requirement", () => {
  const computerCapabilityDetails = parseMigrationComputerCapabilityDetails({
    failures: [
      {
        side: "source",
        reason: "daemon_version_unconfirmed",
        minimumDaemonVersion: "0.72.7",
      },
      {
        side: "target",
        reason: "daemon_version_too_old",
        minimumDaemonVersion: "0.72.7",
      },
      {
        side: "target",
        reason: "runtime_missing",
        runtime: "codex",
      },
    ],
    rawCapabilities: ["must-not-render"],
  });
  assert.ok(computerCapabilityDetails);

  const presentation = migrationErrorPresentation({
    code: "COMPUTER_CAPABILITY_INSUFFICIENT",
    rawMessage: "untrusted aggregate error",
    context: "start",
    computerCapabilityDetails,
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerId: "source-machine",
    targetComputerId: "target-machine",
  }, fm);

  assert.equal(
    presentation.message,
    "Fix these computer requirements before starting the migration:",
  );
  assert.deepEqual(presentation.issues, [
    "Raft could not confirm Source Computer's Raft Computer version. Start or restart it, wait for it to reconnect, and make sure it is version 0.72.7 or later.",
    "Target Computer reported a Raft Computer version older than 0.72.7. Update it, restart it, and wait for it to reconnect.",
    "Target Computer does not support Codex CLI. Install or enable that runtime on this computer, or choose another computer.",
  ]);
  assert.equal(presentation.recovery, "open_computers_and_retry");
  assert.equal(presentation.recoveryComputerId, undefined);
  assert.equal(presentation.technicalCode, "COMPUTER_CAPABILITY_INSUFFICIENT");
  assert.doesNotMatch(JSON.stringify(presentation), /untrusted aggregate error|must-not-render/);

  const zhPresentation = migrationErrorPresentation({
    code: "COMPUTER_CAPABILITY_INSUFFICIENT",
    context: "start",
    computerCapabilityDetails,
    sourceComputerName: "源 Computer",
    targetComputerName: "目标 Computer",
  }, zhIntl.formatMessage);
  assert.equal(zhPresentation.message, "开始迁移前，请先处理以下计算机要求：");
  assert.deepEqual(zhPresentation.issues, [
    "Raft 无法确认 源 Computer 的 Raft Computer 版本。请启动或重启它，等待重新连接，并确认版本不低于 0.72.7。",
    "目标 Computer 报告的 Raft Computer 版本低于 0.72.7。请升级、重启并等待它重新连接。",
    "目标 Computer 不支持 Codex CLI。请在这台计算机上安装或启用该运行时，或另选一台计算机。",
  ]);
});

test("runtime-unconfirmed and runtime-missing capability failures keep distinct actions", () => {
  const computerCapabilityDetails = parseMigrationComputerCapabilityDetails({
    failures: [
      { side: "source", reason: "runtime_unconfirmed", runtime: "codex" },
      { side: "target", reason: "runtime_missing", runtime: "codex" },
    ],
  });
  assert.ok(computerCapabilityDetails);

  const input = {
    code: "COMPUTER_CAPABILITY_INSUFFICIENT" as const,
    context: "start" as const,
    computerCapabilityDetails,
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
  };
  assert.deepEqual(migrationErrorPresentation(input, fm).issues, [
    "Source Computer has not reported whether Codex CLI is available. Start or restart Raft Computer and wait for runtime detection, or choose another computer.",
    "Target Computer does not support Codex CLI. Install or enable that runtime on this computer, or choose another computer.",
  ]);
  assert.deepEqual(migrationErrorPresentation(input, zhIntl.formatMessage).issues, [
    "Source Computer 尚未报告是否支持 Codex CLI。请启动或重启 Raft Computer 并等待运行时检测，或另选一台计算机。",
    "Target Computer 不支持 Codex CLI。请在这台计算机上安装或启用该运行时，或另选一台计算机。",
  ]);
});

test("computer capability detail parser fails closed and one-sided recovery opens the exact computer", () => {
  assert.equal(parseMigrationComputerCapabilityDetails({ failures: [] }), null);
  assert.equal(parseMigrationComputerCapabilityDetails({
    failures: [{ side: "target", reason: "runtime_missing", runtime: "codex<script>" }],
  }), null);
  assert.equal(parseMigrationComputerCapabilityDetails({
    failures: [
      { side: "target", reason: "runtime_missing", runtime: "codex" },
      { side: "target", reason: "runtime_missing", runtime: "codex" },
    ],
  }), null);
  assert.equal(parseMigrationComputerCapabilityDetails({
    failures: [{ side: "target", reason: "secret_capability", runtime: "codex" }],
  }), null);

  const details = parseMigrationComputerCapabilityDetails({
    failures: [
      {
        side: "target",
        reason: "daemon_version_unconfirmed",
        minimumDaemonVersion: "0.72.7",
      },
      { side: "target", reason: "runtime_missing", runtime: "kimi-sdk" },
    ],
  });
  assert.ok(details);
  const presentation = migrationErrorPresentation({
    code: "COMPUTER_CAPABILITY_INSUFFICIENT",
    context: "start",
    computerCapabilityDetails: details,
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerId: "source-machine",
    targetComputerId: "target-machine",
  }, fm);
  assert.equal(presentation.recoveryComputerId, "target-machine");
  assert.deepEqual(presentation.issues, [
    "Raft could not confirm Target Computer's Raft Computer version. Start or restart it, wait for it to reconnect, and make sure it is version 0.72.7 or later.",
    "Target Computer does not support Kimi Code. Install or enable that runtime on this computer, or choose another computer.",
  ]);

  const legacy = migrationErrorPresentation({
    code: "COMPUTER_CAPABILITY_INSUFFICIENT",
    context: "start",
    computerCapabilityDetails: null,
  }, fm);
  assert.equal(
    legacy.message,
    "Both computers must run a compatible Raft Computer version and support this agent's runtime. Update or reconnect them, or choose another computer, then try again.",
  );
  assert.equal(legacy.issues, undefined);
});

test("resumable capability failure identifies the safe side and recovery action", () => {
  const presentation = migrationErrorPresentation({
    code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    rawMessage: "untrusted transport payload must never render",
    context: "start",
    resumableCapabilityDetail: {
      side: "source",
      reason: "protocol_old",
    },
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
    sourceComputerId: "source-machine",
    targetComputerId: "target-machine",
  }, fm);

  assert.equal(
    presentation.message,
    "Source Computer is using an older migration protocol. Update it to Raft Computer v1.0.14 or later, restart it, wait for it to reconnect, then try again.",
  );
  assert.equal(presentation.recovery, "open_computers_and_retry");
  assert.equal(presentation.recoveryComputerId, "source-machine");
  assert.equal(presentation.technicalCode, "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED");
  assert.doesNotMatch(presentation.message, /untrusted transport payload/);
});

test("resumable capability detail parser accepts only the safe enum", () => {
  assert.deepEqual(
    parseMigrationResumableCapabilityDetail({
      side: "target",
      reason: "capability_missing",
      capabilities: ["secret-raw-capability"],
    }),
    { side: "target", reason: "capability_missing" },
  );
  assert.equal(
    parseMigrationResumableCapabilityDetail({
      side: "target",
      reason: "secret-raw-capability",
    }),
    null,
  );

  const presentation = migrationErrorPresentation({
    code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    context: "start",
    resumableCapabilityDetail: null,
    sourceComputerName: "Source Computer",
    targetComputerName: "Target Computer",
  }, fm);
  assert.equal(
    presentation.message,
    "One of these computers is not ready for resumable migration. Update both to Raft Computer v1.0.14 or later, restart them, wait for them to reconnect, then try again.",
  );
});
