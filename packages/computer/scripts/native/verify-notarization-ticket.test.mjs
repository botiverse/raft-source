import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  NotarizationTicketError,
  verifyNotarizationTicket,
} from "./verify-notarization-ticket.mjs";

const workflowPath = fileURLToPath(
  new URL(
    "../../../../.github/workflows/publish-computer-sea.yml",
    import.meta.url,
  ),
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "raft-notary-ticket-"));
  const binaryPath = join(dir, "raft-computer-darwin-x64");
  const receiptPath = `${binaryPath}.notarization.receipt.json`;
  const bytes = Buffer.from("exact-notarized-binary");
  writeFileSync(binaryPath, bytes);
  writeFileSync(
    receiptPath,
    `${JSON.stringify({
      status: "Accepted",
      notary_issues: 0,
      ticket_delivery: "online",
      binary_file: "raft-computer-darwin-x64",
      final_size_bytes: bytes.length,
      final_sha256: createHash("sha256").update(bytes).digest("hex"),
    })}\n`,
  );
  return Promise.resolve(run({ binaryPath, receiptPath })).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function retryableResult() {
  return {
    status: 1,
    stdout: "raft-computer-darwin-x64: valid on disk\n",
    stderr:
      "test-requirement: code failed to satisfy specified code requirement(s)\n",
  };
}

test("accepts bounded online-ticket propagation after exact retryable failures", () =>
  withFixture(async ({ binaryPath, receiptPath }) => {
    const results = [retryableResult(), retryableResult(), { status: 0 }];
    let currentTime = 0;
    const sleeps = [];
    const output = [];
    const verification = await verifyNotarizationTicket({
      binaryPath,
      receiptPath,
      maxWaitMs: 100,
      retryIntervalMs: 25,
      attemptTimeoutMs: 10,
      runCodesign: () => results.shift(),
      now: () => currentTime,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        currentTime += delayMs;
      },
      writeOut: (message) => output.push(message),
      writeErr: () => {},
    });

    assert.deepEqual(verification, { attempts: 3, elapsedMs: 50 });
    assert.deepEqual(sleeps, [25, 25]);
    assert.match(output.join(""), /APPLE_NOTARY_TICKET_VERIFIED attempts=3/);
  }));

test("fails an unclassified permanent codesign rejection without retrying", () =>
  withFixture(async ({ binaryPath, receiptPath }) => {
    let attempts = 0;
    let sleeps = 0;
    await assert.rejects(
      verifyNotarizationTicket({
        binaryPath,
        receiptPath,
        maxWaitMs: 100,
        retryIntervalMs: 25,
        attemptTimeoutMs: 10,
        runCodesign: () => {
          attempts += 1;
          return { status: 1, stderr: "invalid signature" };
        },
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
        },
        writeOut: () => {},
        writeErr: () => {},
      }),
      (error) =>
        error instanceof NotarizationTicketError &&
        error.code === "APPLE_NOTARY_TICKET_PERMANENT_FAILURE",
    );
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
  }));

test("fails the exact six-attempt bad-state shape at a finite deadline without a trailing sleep", () =>
  withFixture(async ({ binaryPath, receiptPath }) => {
    let currentTime = 0;
    let attempts = 0;
    const sleeps = [];
    await assert.rejects(
      verifyNotarizationTicket({
        binaryPath,
        receiptPath,
        maxWaitMs: 125,
        retryIntervalMs: 25,
        attemptTimeoutMs: 10,
        runCodesign: () => {
          attempts += 1;
          return retryableResult();
        },
        now: () => currentTime,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          currentTime += delayMs;
        },
        writeOut: () => {},
        writeErr: () => {},
      }),
      (error) =>
        error instanceof NotarizationTicketError &&
        error.code === "APPLE_NOTARY_TICKET_TIMEOUT" &&
        /after 6 attempts and 125ms/u.test(error.message),
    );
    assert.equal(attempts, 6);
    assert.deepEqual(sleeps, [25, 25, 25, 25, 25]);
  }));

test("rejects a receipt that does not attest the exact binary before codesign", () =>
  withFixture(async ({ binaryPath, receiptPath }) => {
    writeFileSync(binaryPath, "mutated-binary");
    let attempts = 0;
    await assert.rejects(
      verifyNotarizationTicket({
        binaryPath,
        receiptPath,
        maxWaitMs: 100,
        retryIntervalMs: 25,
        attemptTimeoutMs: 10,
        runCodesign: () => {
          attempts += 1;
          return { status: 0 };
        },
        writeOut: () => {},
        writeErr: () => {},
      }),
      (error) =>
        error instanceof NotarizationTicketError &&
        error.code === "APPLE_NOTARY_RECEIPT_REJECTED",
    );
    assert.equal(attempts, 0);
  }));

test.skipIf(inSourceSnapshot)("release workflow delegates to the deadline verifier and cannot restore the fixed-count loop", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const verifyMacosJob = workflow.match(
    /\n  verify_macos:[\s\S]*?\n  publish_candidate:/u,
  )?.[0];
  assert.ok(verifyMacosJob, "verify_macos job must remain present");
  assert.match(
    verifyMacosJob,
    /actions\/setup-node@v5[\s\S]*node-version-file: \.node-version/u,
  );
  assert.match(
    verifyMacosJob,
    /REPO_ROOT="\$PWD"[\s\S]*node "\$REPO_ROOT\/packages\/computer\/scripts\/native\/verify-notarization-ticket\.mjs"[\s\S]*--binary "\$PWD\/\$BINARY"[\s\S]*--receipt "\$PWD\/\$RECEIPT"/u,
  );
  assert.doesNotMatch(verifyMacosJob, /for attempt in 1 2 3 4 5 6/u);
  assert.doesNotMatch(verifyMacosJob, /sleep "\$\(\(attempt \* 5\)\)"/u);
});
