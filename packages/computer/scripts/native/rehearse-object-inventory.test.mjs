import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const script = fileURLToPath(
  new URL("./rehearse-object-inventory.mjs", import.meta.url),
);
const sourceSha = "1".repeat(40);
const candidatePrefix = `computer/candidates/${sourceSha}/`;
const positiveControlPrefix = "computer/manifest.json";

async function withFakeAws(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-provider-rehearsal-"));
  const aws = path.join(root, "aws");
  const log = path.join(root, "aws-calls.jsonl");
  await writeFile(
    aws,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_AWS_EXIT_CODE) process.exit(Number(process.env.FAKE_AWS_EXIT_CODE));
const prefix = args[args.indexOf("--prefix") + 1];
const response = prefix === process.env.FAKE_EMPTY_PREFIX
  ? process.env.FAKE_EMPTY_RESPONSE
  : process.env.FAKE_NONEMPTY_RESPONSE;
process.stdout.write(response);
`,
  );
  await chmod(aws, 0o755);
  try {
    await run({ log, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function rehearse({ log, root }, overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--bucket",
      "fixture-bucket",
      "--source-sha",
      sourceSha,
      "--version",
      "1.0.20",
      "--positive-control-prefix",
      positiveControlPrefix,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_AWS_LOG: log,
        FAKE_EMPTY_PREFIX: candidatePrefix,
        FAKE_EMPTY_RESPONSE: "{}",
        FAKE_NONEMPTY_RESPONSE: JSON.stringify({
          Contents: [{ Key: positiveControlPrefix }],
          KeyCount: 1,
          IsTruncated: false,
        }),
        ...overrides,
      },
    },
  );
}

test("uses only read-only provider lists and emits an exact coordinate receipt", async () => {
  await withFakeAws(async (fixture) => {
    const result = rehearse(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      sourceSha,
      version: "1.0.20",
      bucket: "fixture-bucket",
      candidatePrefix,
      candidateCount: 0,
      positiveControlPrefix,
      positiveControlCount: 1,
    });

    const calls = (await readFile(fixture.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["s3api", "list-objects-v2"],
        ["s3api", "list-objects-v2"],
      ],
    );
    assert.deepEqual(
      calls.map((args) => args[args.indexOf("--prefix") + 1]),
      [candidatePrefix, positiveControlPrefix],
    );
    for (const args of calls) {
      assert.equal(args[args.indexOf("--bucket") + 1], "fixture-bucket");
      assert.equal(args[args.indexOf("--max-keys") + 1], "1000");
      assert.equal(args[args.indexOf("--output") + 1], "json");
    }
  });
});

test("accepts canonical empty Contents as zero", async () => {
  await withFakeAws(async (fixture) => {
    const result = rehearse(fixture, {
      FAKE_EMPTY_RESPONSE: JSON.stringify({ Contents: [], KeyCount: 0 }),
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("fails when the candidate prefix is occupied or the control is empty", async () => {
  await withFakeAws(async (fixture) => {
    const occupied = rehearse(fixture, {
      FAKE_EMPTY_RESPONSE: JSON.stringify({
        Contents: [{ Key: `${candidatePrefix}manifest.json` }],
        KeyCount: 1,
      }),
    });
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /candidate prefix is not empty/);

    const missingControl = rehearse(fixture, {
      FAKE_NONEMPTY_RESPONSE: "{}",
    });
    assert.notEqual(missingControl.status, 0);
    assert.match(missingControl.stderr, /positive-control prefix is empty/);
  });
});

test("fails closed on malformed, contradictory, incomplete, and provider errors", async () => {
  await withFakeAws(async (fixture) => {
    for (const response of [
      "not-json",
      JSON.stringify({ KeyCount: 1, Contents: [] }),
      JSON.stringify({
        Contents: [{ Key: positiveControlPrefix }],
        KeyCount: 1,
        IsTruncated: true,
      }),
      JSON.stringify({
        Contents: [{ Key: positiveControlPrefix }],
        KeyCount: 1,
        NextContinuationToken: "next-page",
      }),
    ]) {
      const result = rehearse(fixture, { FAKE_NONEMPTY_RESPONSE: response });
      assert.notEqual(result.status, 0, response);
      assert.match(result.stderr, /unclassifiable provider response/, response);
    }

    for (const exitCode of ["1", "23"]) {
      const result = rehearse(fixture, { FAKE_AWS_EXIT_CODE: exitCode });
      assert.notEqual(result.status, 0, exitCode);
      assert.match(result.stderr, /provider list request failed/, exitCode);
    }
  });
});
